// The bill draft — verify what was read from the document, then send for
// approval (uploads/ap-claude-code-handoff.md §3). Document left, one flat
// field list right, user-resizable split, sticky commit bar.
//
// Design rulings preserved: per-field read markers (no confidence sections),
// resizable split (never fixed %), payment details read-only from this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  accessApi,
  api,
  billsApi,
  invoiceIntakeApi,
  type BillDraft,
  type BillDraftField,
  type BillDraftLine,
  type CategoryOption,
  type AskCandidate,
  type BillWorkLogEntry,
  type ConfirmBillBody,
  type DocSource,
} from '../api';
import { Ico } from '../dec/icons';
import { BillWorkLog } from '../dec/primitives';
import { useToast } from '../ui/Toast';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type FieldStateMap = Record<string, { value: string; state: BillDraftField['state'] }>;

type BillComment = BillDraft['comments'][number];

/**
 * One subject on a bill, and everything said about it.
 *
 * The head is either a QUESTION — which names somebody and parks the bill until
 * they answer — or a remark raised on its own. Replies are flat underneath:
 * two levels, Slack's shape rather than Reddit's, because what makes this
 * readable is knowing which subject a remark belongs to, and nesting deeper
 * answers that no better in a pane this narrow.
 */
type BillThread = {
  id: string;
  at: string;
  head:
    | { kind: 'question'; question: BillDraft['questions'][number] }
    | { kind: 'comment'; comment: BillComment };
  replies: BillComment[];
};

export function BillDraftPage() {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const billDraft = useQuery({
    queryKey: ['bill-billDraft', organizationId, paymentOrderId],
    queryFn: () => billsApi.draft(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
  });
  // Admin tier decides who may clear a duplicate flag (policy override).
  const myAccess = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });

  // Prev/next walks the draft queue.
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
  });
  const queue = useMemo(
    () => (workbench.data?.bills ?? []).filter((b) => b.bucket === 'draft').map((b) => b.paymentOrderId),
    [workbench.data],
  );

  if (billDraft.isLoading) {
    return (
      <div className="page page-wide">
        <div className="stack stack-24">
          <div className="skeleton" style={{ height: 44 }} />
          <div className="skeleton" style={{ height: 480 }} />
        </div>
      </div>
    );
  }
  if (!billDraft.data) {
    return (
      <div className="page">
        <div className="empty">
          <span className="empty-icon"><Ico.doc w={22} /></span>
          <h4>Bill not found</h4>
          <p>It may have been removed.</p>
        </div>
      </div>
    );
  }

  return (
    <DraftScreen
      key={paymentOrderId}
      organizationId={organizationId}
      billDraft={billDraft.data}
      canOverrideDuplicate={Boolean(myAccess.data?.isPrimaryOrAdmin)}
      canEditBills={myAccess.data ? myAccess.data.capabilities.includes('bills.edit') : true}
      onBack={() => navigate(`/organizations/${organizationId}/bills`)}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
        void queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, paymentOrderId] });
        // Stay on the bill you just sent.
        //
        // This used to jump to the next unprepared bill, on the theory that a
        // clerk works a queue. It reads as the bill vanishing: you press a
        // button and a DIFFERENT invoice is on screen, so there is no moment
        // where you see that what you did worked. The detail page shows the
        // approval chain it just entered and who it is now waiting on, which
        // is the confirmation the action deserves.
        navigate(`/organizations/${organizationId}/bills/${paymentOrderId}`);
      }}
      toast={toast}
    />
  );
}

// Answering a question, which is the one act in this thread that releases the
// bill. Lifted out of the stream because it is the biggest thing in it and was
// burying the conversation it sits inside.
function AnswerComposer(props: {
  question: BillDraft['questions'][number];
  namedFields: string[];
  fieldLabel: (key: string) => string;
  answerText: string;
  setAnswerText: (v: string) => void;
  settled: string[];
  setSettled: (v: string[]) => void;
  forwardTo: string;
  setForwardTo: (v: string) => void;
  candidates: AskCandidate[];
  answering: boolean;
  onSend: (billQuestionId: string, outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded', openFields: string[]) => void;
  onCancel: () => void;
}) {
  const {
    question: q, namedFields, fieldLabel, answerText, setAnswerText, settled, setSettled,
    forwardTo, setForwardTo, candidates, answering, onSend, onCancel,
  } = props;
  const empty = answerText.trim().length < 1;
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        className="input"
        autoFocus
        rows={2}
        style={{ resize: 'vertical', minHeight: 56, lineHeight: 1.5 }}
        placeholder={`Answer ${q.askedByName.split(' ')[0]}…`}
        value={answerText}
        onChange={(e) => setAnswerText(e.target.value)}
      />

      {namedFields.length > 0 ? (
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-muted)' }}>
          {namedFields.map((f) => (
            <label key={f} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={settled.includes(f)}
                onChange={() => setSettled(settled.includes(f) ? settled.filter((k) => k !== f) : [...settled, f])}
              />
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
        <button type="button" className="btn btn-ghost btn-sm" disabled={answering} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={answering || empty}
          title="You could not answer it — it goes back to them, still open."
          onClick={() => onSend(q.billQuestionId, 'handed_back', q.openFields)}>
          Can't answer
        </button>
        {forwardTo ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={answering || empty}
            onClick={() => onSend(q.billQuestionId, 'forwarded', q.openFields)}>
            Pass it on
          </button>
        ) : null}
        {/* Partial only when they named fields and this settles some but not
            all of them — otherwise it is just an answer, and offering both would
            make somebody choose between synonyms. */}
        {namedFields.length > 0 && settled.length > 0 && settled.length < namedFields.length ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={answering || empty}
            onClick={() => onSend(q.billQuestionId, 'partial', q.openFields)}>
            {answering ? 'Sending…' : 'Answer what I can'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={answering || empty}
            onClick={() => onSend(q.billQuestionId, 'answered', q.openFields)}>
            {answering ? 'Sending…' : 'Send answer'}
          </button>
        )}
      </span>
    </div>
  );
}

// A stable colour per person, so the same face keeps the same circle down the
// thread. Hue only — saturation and lightness are fixed so nothing can come out
// unreadable against white text.
function avatarTone(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${hash}, 42%, 45%)`;
}

// "2:14pm" for today, "27 Aug" before that. A conversation wants the time of
// day; a date on every line is noise when they all happened this afternoon.
function shortWhen(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const sameDay = at.getFullYear() === today.getFullYear()
    && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Who settled a check, in the words the work log already used. The thread and
// the log are one account of the bill, so the thread quotes it rather than
// composing a second sentence about the same event.
function flagSettledBy(log: BillWorkLogEntry[], _flagKind: string): string | null {
  const entry = [...log].reverse().find((e) => e.kind === 'flag_cleared');
  if (!entry) return null;
  return `${entry.byName ?? 'Somebody'} settled that check.`;
}

function DraftScreen(props: {
  organizationId: string;
  billDraft: BillDraft;
  canOverrideDuplicate: boolean;
  canEditBills: boolean;
  onBack: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { organizationId, billDraft, canOverrideDuplicate, canEditBills, onBack, onDone, toast } = props;
  // The server already refuses the save and now says so in `readOnly`; this
  // also folds in the viewer's own capabilities, which the Confirm button has
  // always consulted. Both, because myAccess assumes editable while it loads —
  // relying on it alone would flash an editable form at somebody who cannot
  // save it, which is the bug in miniature.
  const readOnly = billDraft.readOnly || !canEditBills;
  const readOnlyNote = !readOnly
    ? null
    : billDraft.readOnlyReason === 'settled'
      ? 'This bill has left draft — its details are settled.'
      : 'Read only. Anyone can bring an invoice in; checking the figures and sending it for approval is the Bill Clerk\u2019s job.';
  const queryClient = useQueryClient();

  // Flag resolutions. One mechanism for every flag rather than a bespoke path
  // per kind — the backend says which are available and who may take them, so
  // this only has to run the one the person chose.
  type ResolutionAction = 'this_is_us' | 'not_ours' | 'ask_someone' | 'clear_duplicate' | 'fix_fields' | 'raise_ceiling' | 'release_vendor' | 'pay_the_lines';
  const [activeResolution, setActiveResolution] = useState<{ flag: string; action: ResolutionAction } | null>(null);
  const [resolutionValue, setResolutionValue] = useState('');
  const [resolving, setResolving] = useState(false);
  const [askOf, setAskOf] = useState('');
  // The model suggests which fields a question is about; the ASKER confirms
  // them before anything is sent. A suggestion nobody sees is an assertion, and
  // if it is wrong the person asked gets pointed at the wrong part of the form
  // with no way to know.
  const [askFields, setAskFields] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Ties what the asker sends back to what we proposed, so an edit is
  // measurable rather than invisible.
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  // What the model proposed, kept separately from what is ticked. Unticking a
  // suggestion must not remove it from the list, or a mis-click is permanent.
  const [suggestedFields, setSuggestedFields] = useState<string[]>([]);
  const [addingField, setAddingField] = useState(false);
  // Whether settling the flag would answer the whole question. Judged once,
  // here, at the moment the question is written — never per edit afterwards.
  const [questionScope, setQuestionScope] = useState<'covered_by_flag' | 'asks_more'>('asks_more');

  const suggestFields = async (question: string, aboutFlag: string | null) => {
    if (question.trim().length < 3) return;
    setSuggesting(true);
    try {
      const res = await billsApi.suggestAskFields(organizationId, billDraft.paymentOrderId, question.trim(), aboutFlag);
      setAskFields(res.fields);
      setSuggestedFields(res.fields);
      setSuggestionId(res.suggestionId);
      setQuestionScope(res.scope);
    } catch {
      setAskFields([]); // no suggestion is fine; the question still sends
      setSuggestedFields([]);
      setQuestionScope('asks_more'); // and nothing may close it but a person
    } finally {
      setSuggesting(false);
    }
  };

  const fieldLabel = (key: string) =>
    [...billDraft.fields, ...billDraft.remitFields].find((f) => f.key === key)?.label
    ?? (key === 'vendor.name' ? 'Vendor name' : key === 'vendor.email' ? 'Email' : key === 'lineItems' ? 'Line items' : key);
  // Fields an unanswered question named, and who asked. This is the payoff of
  // mapping the question: the person asked sees WHERE to look instead of
  // reading a sentence and hunting the form.
  const [openThreadDetail, setOpenThreadDetail] = useState<string | null>(null);
  // Hovering an exchange highlights the fields it concerns, so a reader does
  // not have to hold "which fields was that about" in their head.
  const [hoveredQuestion, setHoveredQuestion] = useState<string | null>(null);
  const askedFields = new Map<string, { by: string; question: string }>();
  for (const q of billDraft.questions) {
    // A handed-back question is still open — the fields it named still want
    // attention, just from someone else now.
    if (!q.stillOpen && hoveredQuestion !== q.billQuestionId) continue;
    // openFields, not highlightFields: a partial answer must stop highlighting
    // what it already settled, or the next person cannot tell which half is left.
    for (const f of q.openFields) if (!askedFields.has(f)) askedFields.set(f, { by: q.askedByName, question: `${q.askedByName}: “${q.question}”` });
  }

  // Conversation is behind a toggle, not always open: the thread grows without
  // bound and would push the document off screen. The strip below is fixed
  // height and always visible, because progress is the thing you want at a
  // glance and the thread is the thing you want on demand.
  //
  // Open by default when somebody is waiting on THIS reader — a question they
  // have to answer should not need finding. That used to be done by exempting
  // those questions from the filter, which made the chevron a control that
  // moved and changed nothing: the one thing on screen ignored it. Opening by
  // default gets the same result and leaves the toggle meaning what it says.
  // Nothing is lost by collapsing, because the header still reads "Somebody is
  // waiting on you" with the count beside it.
  const [showThread, setShowThread] = useState(
    () => billDraft.questions.some((q) => q.youWereAsked && q.stillOpen),
  );
  const openQuestions = billDraft.questions.filter((q) => q.stillOpen).length;

  // Comments: anyone may leave one, and leaving one holds nothing up.
  const [commentText, setCommentText] = useState('');
  // The THREAD being replied to, not an id: a root is either a question or a
  // comment, and which one decides where the reply attaches.
  const [replyTo, setReplyTo] = useState<BillThread | null>(null);
  const [commenting, setCommenting] = useState(false);

  const sendComment = async () => {
    if (commentText.trim().length < 1 || commenting) return;
    setCommenting(true);
    try {
      await billsApi.comment(organizationId, billDraft.paymentOrderId, {
        body: commentText.trim(),
        inReplyToQuestionId: replyTo?.head.kind === 'question' ? replyTo.head.question.billQuestionId : null,
        inReplyToCommentId: replyTo?.head.kind === 'comment' ? replyTo.head.comment.billCommentId : null,
      });
      await queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, billDraft.paymentOrderId] });
      setCommentText('');
      setReplyTo(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not send that');
    } finally {
      setCommenting(false);
    }
  };

  // One stream, oldest first. Questions arrive newest-first from the API
  // because every other surface wants them that way; a conversation reads
  // downward, so it is ordered here rather than changing what everything else
  // gets.
  // Threads, not one stream. A bill collects questions about different things,
  // and flattening them means reading the third one costs scrolling through the
  // first two. Each question — and each remark raised on its own — is a root,
  // and everything said about it hangs underneath and folds away when done.
  const threads = useMemo(() => {
    const byId = new Map<string, BillThread>();
    const order: string[] = [];

    const root = (id: string, at: string, head: BillThread['head']) => {
      if (!byId.has(id)) {
        byId.set(id, { id, at, head, replies: [] });
        order.push(id);
      }
      return byId.get(id)!;
    };

    for (const q of billDraft.questions) {
      root(q.billQuestionId, q.askedAt, { kind: 'question', question: q });
    }
    // Roots first, so a reply always finds the thread it belongs to. Comments
    // arrive oldest-first, so a reply cannot precede its own root.
    for (const c of billDraft.comments) {
      const parentId = c.inReplyToQuestionId ?? c.inReplyToCommentId;
      if (!parentId) {
        root(c.billCommentId, c.at, { kind: 'comment', comment: c });
        continue;
      }
      const parent = byId.get(parentId);
      // A reply whose root we cannot see — the question was deleted, or it
      // arrived out of order — stands on its own rather than vanishing.
      if (!parent) {
        root(c.billCommentId, c.at, { kind: 'comment', comment: c });
        continue;
      }
      parent.replies.push(c);
    }

    return order
      .map((id) => byId.get(id)!)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [billDraft.questions, billDraft.comments]);

  // Collapsed by choice, not by rule: an answered question is done, so it folds
  // itself away and leaves the bill's live conversation on screen. Anything
  // still owed stays open, because that is the part somebody has to act on.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (t: BillThread) => expanded[t.id]
    ?? (t.head.kind === 'question' ? t.head.question.stillOpen : true);

  const [answerFor, setAnswerFor] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [answering, setAnswering] = useState(false);
  const [settled, setSettled] = useState<string[]>([]);
  const [forwardTo, setForwardTo] = useState('');

  const sendAnswer = async (
    billQuestionId: string,
    outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded',
    openFields: string[],
  ) => {
    if (answerText.trim().length < 1) return;
    if (outcome === 'forwarded' && !forwardTo) return;
    setAnswering(true);
    try {
      await billsApi.answerQuestion(organizationId, billDraft.paymentOrderId, billQuestionId, {
        answer: answerText.trim(),
        outcome,
        resolvedFields: outcome === 'answered' ? openFields : settled,
        forwardTo: outcome === 'forwarded' ? { userId: forwardTo, question: answerText.trim() } : null,
      });
      await queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, billDraft.paymentOrderId] });
      toast.success(
        outcome === 'answered' ? 'Answered — the bill moves on.'
          : outcome === 'partial' ? 'Saved. What you could not answer stays open for them.'
          : outcome === 'forwarded' ? 'Passed on. They will see what is still outstanding.'
          : 'Sent back — they will see it is still open.',
        outcome === 'answered' ? 'Thanks' : outcome === 'partial' ? 'Partly answered' : outcome === 'forwarded' ? 'Forwarded' : 'Handed back',
      );
      setAnswerFor(null);
      setAnswerText('');
      setSettled([]);
      setForwardTo('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not send that');
    } finally {
      setAnswering(false);
    }
  };
  // Keyed on the flag too: who can settle a bill addressed to another company
  // is not who can settle its arithmetic, and a cached list from the last flag
  // would quietly mark the wrong people.
  const askAboutFlag = activeResolution?.action === 'ask_someone' ? activeResolution.flag : null;
  const askCandidates = useQuery({
    queryKey: ['ask-candidates', organizationId, billDraft.paymentOrderId, askAboutFlag],
    queryFn: () => billsApi.askCandidates(organizationId, billDraft.paymentOrderId, askAboutFlag),
    enabled: activeResolution?.action === 'ask_someone' || answerFor !== null,
  });

  // The QUESTION being asked, stated above the input. A bare box under the
  // flag's own sentence tells you nothing about what you are typing or what it
  // will do — which was the complaint: three different actions all looked like
  // the same unexplained field under the same red sentence.
  const resolutionAsk = (action: ResolutionAction, claimed: string) =>
    action === 'this_is_us'
      ? {
          title: `Is "${claimed}" a name ${billDraft.organizationName ?? 'your organization'} trades under?`,
          help: 'Confirm the name below. It is recorded against your organization, so bills addressed to it are never flagged again — and only a primary admin or admin can do this.',
          label: 'Name to record',
          cta: 'Yes, record it',
        }
      : action === 'not_ours'
      ? {
          title: 'Close this bill as not yours to pay?',
          help: 'The bill stops here and no payment is made. Say why — it goes on the record, and it is what the vendor is told if anyone follows up.',
          label: 'Why is it not yours?',
          cta: 'Close the bill',
        }
      : action === 'pay_the_lines'
      ? {
          // Both numbers, spelled out. The decision is which of two figures
          // leaves the building, and it should not have to be reconstructed
          // from the sentence above.
          title: `Pay ${usd(computedTotal)} instead of the ${usd(documentTotal)} printed?`,
          help: 'For an invoice that does not add up: you pay what it itemises and take it up with the vendor. Your reason goes to the approvers with the bill, so the smaller figure reads as a decision rather than a slip.',
          label: 'Why pay the itemised total?',
          cta: `Pay ${usd(computedTotal)}`,
        }
      : {
          title: 'Clear the duplicate flag?',
          help: 'You are asserting this is a genuinely new bill, not one already paid. Your reason becomes the audit record for that decision.',
          label: 'Why is it not a duplicate?',
          cta: 'Clear the flag',
        };


  function startResolution(flagKind: string, action: ResolutionAction) {
    // Actions that only point somewhere else need no input and no ceremony.
    if (action === 'fix_fields') {
      toast.info('Correct the fields below, then confirm the bill.', 'Check the details');
      return;
    }
    if (action === 'raise_ceiling' || action === 'release_vendor') {
      toast.info('This is changed where it was set, not on the bill — Policies for a ceiling, the vendor for a hold.', 'Needs an admin');
      return;
    }
    if (action === 'ask_someone') {
      setActiveResolution({ flag: flagKind, action });
      setResolutionValue('');
      setAskOf('');
      setAskFields(null);
      setSuggestedFields([]);
      setAddingField(false);
      setSuggestionId(null);
      setQuestionScope('asks_more');
      return;
    }
    // Prefill the name being claimed; it is almost always the right answer and
    // retyping a company name off the screen is a needless chance to fat-finger it.
    const flag = billDraft.flags.find((f) => f.kind === flagKind);
    const claimed = action === 'this_is_us' ? /addressed to "([^"]+)"/.exec(flag?.message ?? '')?.[1] ?? '' : '';
    setActiveResolution({ flag: flagKind, action });
    setResolutionValue(claimed);
  }

  const runResolution = async () => {
    if (!activeResolution || resolutionValue.trim().length < 3) return;
    const { action } = activeResolution;
    setResolving(true);
    try {
      if (action === 'this_is_us') {
        await billsApi.thisIsUs(organizationId, billDraft.paymentOrderId, { name: resolutionValue.trim() });
        toast.success('Recorded — bills addressed to that name will not be flagged again.', 'This is us');
      } else if (action === 'clear_duplicate') {
        await billsApi.overrideDuplicate(organizationId, billDraft.paymentOrderId, resolutionValue.trim());
        toast.success('Cleared — your reason is on the bill’s record.', 'Duplicate flag');
      } else if (action === 'ask_someone') {
        await billsApi.ask(organizationId, billDraft.paymentOrderId, {
          askedOfUserId: askOf,
          question: resolutionValue.trim(),
          aboutFlag: activeResolution.flag,
          highlightFields: askFields,
          suggestionId,
          questionScope,
        });
        toast.success('Asked. The bill waits on their answer rather than moving on.', 'Question sent');
      } else if (action === 'pay_the_lines') {
        // Save first. The server adds up the lines it has stored, so deciding
        // to pay them while the screen holds unsaved edits would record a
        // number nobody is looking at.
        await billsApi.saveDraft(organizationId, billDraft.paymentOrderId, currentBody());
        await billsApi.payItemised(organizationId, billDraft.paymentOrderId, resolutionValue.trim());
        toast.success('Recorded — the approvers will see the amount and why it changed.', 'Paying the itemised total');
      } else if (action === 'not_ours') {
        await billsApi.notABill(organizationId, billDraft.paymentOrderId, { reason: 'not_ours', note: resolutionValue.trim() });
        toast.success('Closed as addressed to another company.', 'Not ours');
        onDone();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, billDraft.paymentOrderId] });
      setActiveResolution(null);
      setResolutionValue('');
      setConfirmError(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not resolve that');
    } finally {
      setResolving(false);
    }
  };

  // --- field state ---------------------------------------------------------
  const [fields, setFields] = useState<FieldStateMap>(() => {
    const map: FieldStateMap = {};
    for (const f of [...billDraft.fields, ...billDraft.remitFields]) {
      map[f.key] = { value: f.value == null ? '' : String(f.value), state: f.state };
    }
    // The vendor name and email keep their VALUE in their own state, because
    // they are bound to their own inputs — but their confirmed-ness belongs
    // here with everything else, so confirming one is recorded and survives a
    // reload like any other field. Without this they were the only fields that
    // could be asked about and never checked off, which is why the screen grew
    // a second, weaker marker for them.
    map['vendor.name'] = { value: billDraft.vendor.name, state: billDraft.vendor.nameState };
    map['vendor.email'] = { value: billDraft.vendor.email ?? '', state: billDraft.vendor.emailState };
    return map;
  });
  const [lines, setLines] = useState<BillDraftLine[]>(() =>
    billDraft.lines.length > 0 ? billDraft.lines : [{ description: '', quantity: 1, unitPrice: null, amount: null, category: null }],
  );
  const [tax, setTax] = useState<string>(billDraft.taxAmount != null ? String(billDraft.taxAmount) : '0');
  const [vendorName, setVendorName] = useState(billDraft.vendor.name);
  const [vendorEmail, setVendorEmail] = useState(billDraft.vendor.email ?? '');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notABillOpen, setNotABillOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Field ↔ document linking: focusing a field highlights where it was read.
  const [activeSource, setActiveSource] = useState<DocSource>(null);

  // Chart of accounts for the category picker — same source and cache as the
  // coding inbox. Falls back to the draft packet's options, then to whatever
  // categories the lines already carry, so the list is stable and never
  // shrinks when a selection changes.
  const accountsQuery = useQuery({
    queryKey: ['qbo-accounts', organizationId] as const,
    queryFn: () => api.listQuickBooksAccounts(organizationId),
    enabled: Boolean(organizationId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const categoryOptions = useMemo<CategoryOption[]>(() => {
    // Prefer the live chart (full, numbered, grouped like the books); fall back
    // to the draft packet's options (builtin chart when QBO isn't connected).
    const fromBooks: CategoryOption[] = (accountsQuery.data?.items ?? []).map((a) => ({
      value: a.fullyQualifiedName ?? a.name,
      label: a.acctNum ? `${a.acctNum} · ${a.fullyQualifiedName ?? a.name}` : (a.fullyQualifiedName ?? a.name),
      group: a.accountType,
    }));
    const seed = fromBooks.length > 0 ? fromBooks : billDraft.categoryOptions;
    // A category already on a line (an older suggestion, or from before a chart
    // change) stays selectable instead of silently disappearing.
    const known = new Set(seed.map((o) => o.value));
    const extras: CategoryOption[] = [];
    for (const line of billDraft.lines) {
      if (line.category && !known.has(line.category)) {
        known.add(line.category);
        extras.push({ value: line.category, label: line.category, num: null, group: 'Suggestions' });
      }
    }
    return [...extras, ...seed];
  }, [accountsQuery.data, billDraft.categoryOptions, billDraft.lines]);

  const setFieldValue = (key: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      // Typing a correction settles the field — the edit is the confirmation.
      [key]: { value, state: prev[key]?.state === 'needs_look' ? 'confirmed' : prev[key]?.state ?? 'read' },
    }));
  };
  const confirmField = (key: string) => {
    setFields((prev) => ({ ...prev, [key]: { value: prev[key]?.value ?? '', state: 'confirmed' } }));
  };

  // --- arithmetic strip ----------------------------------------------------
  const linesTotal = lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const taxNumber = Number(tax) || 0;
  const computedTotal = linesTotal + taxNumber;
  const documentTotal = Number(fields.total?.value) || 0;
  const arithmeticOk = lines.every((l) => !l.description) || Math.abs(computedTotal - documentTotal) < 0.005;

  // --- flags + Tier-1 gate ---------------------------------------------------
  // Approval routes on amount + coded lines: those must exist before sending.
  // Everything else (due date, invoice number, address…) can be filled while
  // the bill is already in approval.
  const blockingFlags = billDraft.flags.filter((f) => f.blocking);
  const realLines = lines.filter((l) => l.description.trim());
  const tier1Gap = documentTotal <= 0
    ? 'Add the total due before sending.'
    : realLines.length === 0
      ? 'Add at least one line item before sending.'
      : (() => {
          const noAmount = realLines.findIndex((l) => l.amount == null);
          if (noAmount >= 0) return `Add an amount to line ${noAmount + 1} before sending.`;
          // Categories don't gate (GL synthesis): an uncoded line parks in
          // "Uncategorized expense" for the accountant to place later.
          return null;
        })();
  // Preparing a bill is the Bill Clerk's job. An Approver or a Payer can read
  // every word of this screen — that is deliberate, they are the ones who will
  // carry the decision — but confirming it is not theirs to do, and the server
  // refuses. Offering the button anyway produced "Your role doesn't include
  // this" AFTER the click, which is the same dead end the approve path had.
  const canConfirm = canEditBills && !readOnly && blockingFlags.length === 0 && !submitting && !tier1Gap;

  // What is on the screen right now, in the shape both confirm and save send.
  // One builder, so a saved draft and a confirmed one can never disagree about
  // what "exactly as shown" meant.
  const currentBody = useCallback((): ConfirmBillBody => ({
        fields: {
          vendorName: vendorName.trim() || null,
          vendorEmail: vendorEmail.trim() || null,
          invoiceNumber: fields.invoiceNumber?.value || null,
          invoiceDate: fields.invoiceDate?.value || null,
          dueDate: fields.dueDate?.value || null,
          terms: fields.terms?.value || null,
          poNumber: fields.poNumber?.value || null,
          discount: fields.discount?.value || null,
          currency: fields.currency?.value || 'USD',
          total: documentTotal,
          taxAmount: taxNumber,
          remitTo: {
            street: fields['remitTo.street']?.value || null,
            city: fields['remitTo.city']?.value || null,
            state: fields['remitTo.state']?.value || null,
            zip: fields['remitTo.zip']?.value || null,
          },
        },
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: l.amount,
            category: l.category ?? null,
          })),
        confirmedFieldKeys: Object.entries(fields)
          .filter(([, f]) => f.state === 'confirmed')
          .map(([key]) => key),
    noteForApprovers: note.trim() || null,
  }), [fields, lines, documentTotal, taxNumber, note, vendorName, vendorEmail]);

  // --- save: keep it, send nothing ------------------------------------------
  const saveChanges = useCallback(async () => {
    if (!canEditBills || readOnly || saving) return;
    setSaving(true);
    try {
      await billsApi.saveDraft(organizationId, billDraft.paymentOrderId, currentBody());
      // Stay on the bill. Saving is not leaving — being thrown back to the list
      // every time you keep your work makes the button feel like a way out
      // rather than a way to hold on to what you typed.
      //
      // Which means the flags have to catch up here, since nothing is going to
      // remount and re-read them. Refetching keeps the form exactly as it is
      // (the screen is keyed on the bill, not the data) and updates the banner
      // — so correcting the figures and pressing save shows the flag clearing,
      // instead of leaving a warning on screen that is no longer true.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, billDraft.paymentOrderId] }),
        queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] }),
      ]);
      toast.success('Saved', 'Your changes are kept — this bill has not been sent for approval.');
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  }, [canEditBills, readOnly, saving, organizationId, billDraft.paymentOrderId, currentBody, toast, queryClient]);

  // --- commit ---------------------------------------------------------------
  const confirm = useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const body = currentBody();
      await billsApi.confirm(organizationId, billDraft.paymentOrderId, body);
      toast.success('Sent for approval', 'Recorded exactly as shown on this screen.');
      onDone();
    } catch (err) {
      // A refused confirm needs a PERSISTENT explanation, not just a 5-second
      // toast — the server's message says exactly what to fix (testbench 001
      // saw the refusal vanish entirely).
      setConfirmError(err instanceof Error ? err.message : 'The bill could not be sent. Try again.');
      toast.error('Could not send', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  }, [canConfirm, currentBody, organizationId, billDraft.paymentOrderId, toast, onDone]);

  // ⌘↵ confirms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void confirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  // --- resizable split ------------------------------------------------------
  const shellRef = useRef<HTMLDivElement>(null);
  const [panelPct, setPanelPct] = useState(38);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setPanelPct(Math.min(70, Math.max(28, 100 - pct)));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return (
    <div className="rev-shell" ref={shellRef}>
      {/* Topbar */}
      <div className="topbar">
        <div className="tb-context">
          <button type="button" className="btn btn-ghost tb-back" onClick={onBack}>
            <Ico.chevLeft w={15} /> Bills
          </button>
          {/* Who put this bill here — a bill clerk's first question when a bill
              they didn't upload appears in their queue. */}
          {billDraft.sourceLabel ? (
            <span className="cell-source" style={{ marginLeft: 12 }}>
              {billDraft.source === 'email' ? <Ico.mail w={15} /> : <Ico.upload w={15} />}
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{billDraft.sourceLabel}</span>
            </span>
          ) : null}
        </div>

      </div>

      {/* Split: read panel LEFT, document RIGHT (matches the approved mock). */}
      <div className="rev-split">
        {/* The reason the form is locked lives on hover rather than in a
            banner. It is a fact about the reader, not news about the bill, and
            a permanent box explaining what somebody CANNOT do is a poor use of
            the space a bill needs. */}
        <div
          className="rev-panel"
          style={{ width: `${100 - panelPct}%` }}
          title={readOnlyNote ?? undefined}
        >
          <div className="stack stack-20">
            {/* The bill's major facts, as the heading */}
            <div className="rev-head">
              <div>
                <h1>{fields.invoiceNumber?.value || vendorName}</h1>
                <div className="rh-sub">{vendorName}</div>
              </div>
              <div className="rh-amount">{usd(documentTotal)}</div>
            </div>

            {/* Sent back by an approver — the bill clerk's homework, above all flags */}
            {billDraft.sentBack ? (
              <div className="callout callout-warning">
                <Ico.reset w={16} />
                <span>
                  <b>{billDraft.sentBack.byName ?? 'An approver'} sent this bill back{billDraft.sentBack.reason ? ':' : '.'}</b>
                  {billDraft.sentBack.reason ? ` “${billDraft.sentBack.reason}”` : ''} Fix it below and confirm again — it will go through approval fresh.
                </span>
              </div>
            ) : null}

            {/* A refused confirm stays on screen until the next attempt. A
                duplicate refusal carries the same admin affordance as the
                flag banner — no dead ends (testbench 002 §3). */}
            {confirmError ? (
              <div className="callout callout-danger" data-testid="confirm-error">
                <Ico.shield w={16} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {confirmError}
                  {/duplicate/i.test(confirmError) && !canOverrideDuplicate
                    ? ' Change the invoice number if this is a distinct bill, or ask an admin.'
                    : null}
                  {/duplicate/i.test(confirmError) && canOverrideDuplicate && activeResolution?.action === 'clear_duplicate' ? (
                    <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input className="input" value={resolutionValue} autoFocus placeholder="Why is it not a duplicate? Goes on the record."
                        onChange={(e) => setResolutionValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void runResolution(); }}
                        style={{ flex: 1, minWidth: 0, height: 32 }} />
                      <button type="button" className="btn btn-primary btn-sm" style={{ flex: 'none' }}
                        disabled={resolving || resolutionValue.trim().length < 3} onClick={() => void runResolution()}>
                        {resolving ? 'Clearing…' : 'Clear flag'}
                      </button>
                    </span>
                  ) : null}
                </span>
                {/duplicate/i.test(confirmError) && canOverrideDuplicate && activeResolution?.action !== 'clear_duplicate' ? (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 'none' }}
                    onClick={() => startResolution('possible_duplicate', 'clear_duplicate')}>
                    Not a duplicate
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Progress and the conversation are one component: both answer
                "where is this bill", so they belong above the same rule rather
                than the thread appearing to be page content. */}
            {/* The conversation used to live INSIDE this strip, which only
                rendered once a bill had an approval route. So a question asked
                while the bill was still a draft — the most useful moment to
                ask one, since the figures can still be fixed — had nowhere to
                appear on the very screen it was about. The strip now shows for
                a route OR a question, and the route half is what is optional. */}
            {billDraft.route.length > 0 || billDraft.questions.length > 0 ? (
              <div style={{ margin: '-20px -24px 0', padding: '12px 24px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {billDraft.route.length > 0 ? (
                    <>
                      {billDraft.route.map((n, i) => (
                        <span key={`${n.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className={`pill pill-min ${n.state === 'done' ? 'pill-success' : n.state === 'waiting' ? 'pill-warning' : n.state === 'declined' ? 'pill-danger' : 'pill-neutral'}`}>
                            <span className="dot" />{n.name.split(' ')[0]}
                          </span>
                          {i < billDraft.route.length - 1 ? <span style={{ color: 'var(--text-faint)' }}>→</span> : null}
                        </span>
                      ))}
                      <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>
                        {billDraft.route.filter((n) => n.state === 'done').length} of {billDraft.route.length} approved
                      </span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {billDraft.questions.some((q) => q.youWereAsked && q.stillOpen)
                        ? 'Somebody is waiting on you'
                        : 'Questions on this bill'}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {/* Count OUTSIDE the button: a number crammed into a round
                      icon button reads as a badge on nothing and crowds the
                      chevron it sits next to. */}
                  {billDraft.questions.length > 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>{billDraft.questions.length}</span>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-expanded={showThread}
                    aria-label={showThread ? 'Hide conversation' : 'Show conversation'}
                    title={showThread ? 'Hide conversation' : 'Show conversation'}
                    onClick={() => setShowThread(!showThread)}
                  >
                    <Ico.chevDown w={14} style={{ transform: showThread ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }} />
                  </button>
                </div>

                {/* One conversation, in order, the way people already expect
                    a conversation to look. Two kinds of message share it: a
                    QUESTION, which names somebody and parks the bill until they
                    answer, and a COMMENT, which parks nothing.

                    They are different shapes on purpose. The whole value of a
                    question is that "waiting on Zara" is TRUE — a hold with a
                    name on it — and if it looked like chatter that would stop
                    being visible. So a question is bordered and amber while it
                    is owed; a comment is a quiet bubble.

                    Anyone may reply to a question; only the person asked may
                    answer it. That is the same split, drawn once more: helping
                    is open, releasing the bill is not. */}
                {showThread ? (
                  <div className="bthread">
                    {threads.map((t) => {
                      const open = isOpen(t);
                      const q = t.head.kind === 'question' ? t.head.question : null;
                      const isAnswered = q?.outcome === 'answered';
                      const namedFields = q ? (q.openFields.length ? q.openFields : q.highlightFields) : [];
                      const author = q ? q.askedByName : t.head.kind === 'comment' ? t.head.comment.authorName : '';
                      return (
                        <div
                          key={t.id}
                          className="bt-thread"
                          onMouseEnter={() => q && setHoveredQuestion(q.billQuestionId)}
                          onMouseLeave={() => setHoveredQuestion(null)}
                        >
                          <div className="bt-msg">
                            <span className="bt-av" style={{ background: avatarTone(author) }}>
                              {initialsOf(author)}
                            </span>
                            <div className="bt-col">
                              <div className="bt-who">
                                <strong>{author}</strong>
                                {q ? (
                                  <>
                                    <span>asked</span>
                                    <strong>{q.askedOfName}</strong>
                                    <span className={`pill pill-min ${isAnswered ? 'pill-success' : 'pill-warning'}`}>
                                      <span className="dot" />
                                      {isAnswered ? `${q.askedOfName.split(' ')[0]} confirmed these details`
                                        : q.outcome === 'partial' ? 'Partly answered'
                                        : q.outcome === 'forwarded' ? 'Passed on'
                                        : q.outcome === 'handed_back' ? `${q.askedOfName.split(' ')[0]} could not answer`
                                        : `Waiting on ${q.askedOfName.split(' ')[0]}`}
                                    </span>
                                  </>
                                ) : null}
                                <span className="bt-when">{shortWhen(t.at)}</span>
                                <span style={{ flex: 1 }} />
                                {/* The fold. A bill with six settled questions
                                    on it should read as six lines, not six
                                    forms — the detail is there when somebody
                                    goes looking and out of the way when not. */}
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm"
                                  aria-expanded={open}
                                  aria-label={open ? 'Collapse this thread' : 'Expand this thread'}
                                  onClick={() => setExpanded({ ...expanded, [t.id]: !open })}
                                >
                                  <Ico.chevDown w={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }} />
                                </button>
                              </div>

                              <div className={q ? `bt-bubble is-question${q.stillOpen ? ' is-waiting' : ''}` : 'bt-bubble'}>
                                {q ? q.question : t.head.kind === 'comment' ? t.head.comment.body : null}
                                {open && namedFields.length > 0 ? (
                                  <div className="bt-fields">
                                    {namedFields.map((f) => (
                                      <span key={f} className="pill pill-min pill-neutral">{fieldLabel(f)}</span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>

                              {/* Collapsed, a thread still has to say what is
                                  under it, or folding it away hides that anyone
                                  replied at all. */}
                              {!open && t.replies.length > 0 ? (
                                <button type="button" className="bt-more"
                                  onClick={() => setExpanded({ ...expanded, [t.id]: true })}>
                                  {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
                                </button>
                              ) : null}

                              {open ? (
                                <>
                                  {q?.answer ? (
                                    <div className="bt-note">
                                      <strong>{q.askedOfName.split(' ')[0]}:</strong> “{q.answer}”
                                    </div>
                                  ) : null}

                                  {/* Ticking the fields IS the answer to "please
                                      check these" — but a tick lives on this
                                      screen until the bill is saved. */}
                                  {(() => {
                                    if (!q?.stillOpen || q.openFields.length === 0) return null;
                                    const checked = q.openFields.filter((f) => fields[f]?.state === 'confirmed');
                                    if (checked.length === 0) return null;
                                    return (
                                      <div className="bt-note">
                                        {checked.length === q.openFields.length
                                          ? `You have checked all ${q.openFields.length} fields. Save the bill and that goes back as your answer.`
                                          : `You have checked ${checked.length} of ${q.openFields.length}. Saving sends what you have done so far.`}
                                      </div>
                                    );
                                  })()}

                                  {q?.stillOpen && q.aboutFlag
                                    && !billDraft.flags.some((f) => f.kind === q.aboutFlag) ? (
                                    <div className="bt-note">
                                      {flagSettledBy(billDraft.workLog, q.aboutFlag) ?? 'That check has been settled.'}
                                      {' '}Your question asked more than that — write the rest to close it.
                                    </div>
                                  ) : null}

                                  {t.replies.length > 0 ? (
                                    <div className="bt-replies">
                                      {t.replies.map((r) => (
                                        <div key={r.billCommentId} className="bt-msg">
                                          <span className="bt-av is-sm" style={{ background: avatarTone(r.authorName) }}>
                                            {initialsOf(r.authorName)}
                                          </span>
                                          <div className="bt-col">
                                            <div className="bt-who">
                                              <strong>{r.authorName}</strong>
                                              <span className="bt-when">{shortWhen(r.at)}</span>
                                            </div>
                                            <div className="bt-bubble">{r.body}</div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}

                                  {q && q.youWereAsked && answerFor === q.billQuestionId ? (
                                    <AnswerComposer
                                      question={q}
                                      namedFields={namedFields}
                                      fieldLabel={fieldLabel}
                                      answerText={answerText}
                                      setAnswerText={setAnswerText}
                                      settled={settled}
                                      setSettled={setSettled}
                                      forwardTo={forwardTo}
                                      setForwardTo={setForwardTo}
                                      candidates={askCandidates.data?.candidates ?? []}
                                      answering={answering}
                                      onSend={sendAnswer}
                                      onCancel={() => { setAnswerFor(null); setAnswerText(''); setSettled([]); setForwardTo(''); }}
                                    />
                                  ) : !readOnly ? (
                                    <div className="bt-actions">
                                      {q?.youWereAsked ? (
                                        <button type="button" className="btn btn-secondary btn-sm"
                                          onClick={() => { setAnswerFor(q.billQuestionId); setAnswerText(''); setSettled([]); setForwardTo(''); }}>
                                          Answer
                                        </button>
                                      ) : null}
                                      {/* Open to everybody, the asker included.
                                          Helping is not releasing the bill. */}
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
                      );
                    })}

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
                ) : null}
              </div>
            ) : null}

            {/* A flag states what is wrong AND what can be done about it. The
                rule the backend enforces: every blocking flag offers at least
                one way out, so this never renders a dead end. */}
            {billDraft.flags.map((flag) => (
              <div
                key={flag.kind}
                className={`callout ${flag.severity === 'danger' ? 'callout-danger' : flag.severity === 'warning' ? 'callout-warning' : 'callout-info'}`}
              >
                <Ico.shield w={16} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {flag.message}
                  {activeResolution?.flag === flag.kind ? (() => {
                    const asking = activeResolution.action === 'ask_someone';
                    const claimed = /addressed to "([^"]+)"/.exec(flag.message)?.[1] ?? '';
                    const ask = asking ? null : resolutionAsk(activeResolution.action, claimed);
                    const people = askCandidates.data?.candidates ?? [];
                    const ready = asking
                      ? Boolean(askOf) && resolutionValue.trim().length >= 3
                      : resolutionValue.trim().length >= 3;
                    return (
                      <span style={{ display: 'block', marginTop: 10 }}>
                        {/* State the question. A bare box under the flag's own
                            sentence never said what you were typing or what it
                            would do. */}
                        <strong style={{ display: 'block' }}>
                          {asking ? 'Who should answer this?' : ask!.title}
                        </strong>
                        <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
                          {asking
                            ? 'The bill waits for their answer instead of moving on. Anyone can ask.'
                            : ask!.help}
                        </span>

                        {asking && people.length === 0 ? (
                          <span style={{ display: 'block', marginTop: 8 }}>
                            There is nobody else in this organization to ask yet. Invite a colleague from Members first.
                          </span>
                        ) : (
                          <span style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                            {asking ? (
                              <select className="input" value={askOf} onChange={(e) => setAskOf(e.target.value)}
                                style={{ flex: '0 0 240px', height: 32 }}>
                                <option value="">Choose a colleague…</option>
                                {/* Split, not filtered. The people who can settle
                                    this go first; everyone else stays reachable,
                                    because "do we trade as Halcyon Labs?" is a
                                    question for whoever KNOWS, who is often not
                                    an admin. */}
                                {people.some((c) => c.canSettle) ? (
                                  <>
                                    <optgroup label="Can settle this">
                                      {people.filter((c) => c.canSettle).map((c) => (
                                        <option key={c.userId} value={c.userId}>
                                          {c.name}{c.answered > 0 ? ` — answered ${c.answered}` : ''}
                                        </option>
                                      ))}
                                    </optgroup>
                                    <optgroup label="Can help, but can't settle it">
                                      {people.filter((c) => !c.canSettle).map((c) => (
                                        <option key={c.userId} value={c.userId}>
                                          {c.name}{c.jobRole ? ` — ${c.jobRole.replace(/_/g, ' ')}` : ''}
                                        </option>
                                      ))}
                                    </optgroup>
                                  </>
                                ) : (
                                  people.map((c) => (
                                    <option key={c.userId} value={c.userId}>
                                      {c.name}{c.answered > 0 ? ` — answered ${c.answered}` : ''}
                                    </option>
                                  ))
                                )}
                              </select>
                            ) : null}
                            <input
                              className="input"
                              autoFocus={!asking}
                              value={resolutionValue}
                              placeholder={asking ? 'What do you want to know?' : ask!.label}
                              onChange={(e) => setResolutionValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' || !ready) return;
                                // Enter used to call runResolution directly and
                                // skip straight past the confirm step — so the
                                // question went out with fields nobody had been
                                // shown, chosen server-side, which is precisely
                                // the "a suggestion nobody sees is an assertion"
                                // this two-step exists to prevent. It has to
                                // advance the same way the button does.
                                if (asking && askFields === null) {
                                  void suggestFields(resolutionValue, activeResolution.flag);
                                  return;
                                }
                                void runResolution();
                              }}
                              style={{ flex: 1, minWidth: 0, height: 32 }}
                            />
                            <button type="button" className="btn btn-primary btn-sm" style={{ flex: 'none' }}
                              disabled={resolving || !ready || (asking && suggesting)}
                              onClick={() => {
                                // Two steps on purpose: suggest, then confirm.
                                // The asker sees exactly what the other person
                                // will be pointed at before it is sent.
                                if (asking && askFields === null) { void suggestFields(resolutionValue, activeResolution.flag); return; }
                                void runResolution();
                              }}>
                              {resolving ? 'Saving…'
                                : asking && suggesting ? 'Reading…'
                                : asking && askFields === null ? 'Next'
                                : asking ? 'Ask' : ask!.cta}
                            </button>
                          </span>
                        )}
                        {asking && askFields !== null ? (() => {
                          // Unticking used to DELETE the row, so a mis-click was
                          // unrecoverable — the field left the list and there
                          // was no way back to it. And the model's guess was the
                          // whole universe: nothing could be added that it had
                          // not thought of.
                          //
                          // Suggested fields stay on screen whether ticked or
                          // not, and everything else in the vocabulary is one
                          // click away. `suggestedFields` is frozen at the
                          // moment of suggestion so the list does not reshuffle
                          // under the cursor as boxes are ticked.
                          const picked = new Set(askFields);
                          const shown = [...new Set([...suggestedFields, ...askFields])];
                          const rest = billDraft.highlightableFields.filter((k) => !shown.includes(k));
                          const toggle = (key: string) => setAskFields(
                            picked.has(key) ? askFields.filter((k) => k !== key) : [...askFields, key],
                          );
                          return (
                          <span style={{ display: 'block', marginTop: 10 }}>
                            <strong style={{ display: 'block' }}>
                              {shown.length > 0
                                ? 'These are the fields they will be asked to fill — right?'
                                : 'This does not look like it is about a specific field.'}
                            </strong>
                            <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
                              {shown.length > 0
                                ? 'Ticked ones are highlighted on their screen. Untick what does not belong, and add anything missing.'
                                : 'It will be sent as a plain question unless you point at something.'}
                            </span>
                            {shown.length > 0 ? (
                              <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                                {shown.map((key) => (
                                  <label key={key} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                    <input
                                      type="checkbox"
                                      checked={picked.has(key)}
                                      onChange={() => toggle(key)}
                                    />
                                    {fieldLabel(key)}
                                  </label>
                                ))}
                              </span>
                            ) : null}

                            {/* Anything the model did not think of. A question
                                is often about a field precisely BECAUSE the
                                reading of it looks wrong, which is the case a
                                suggestion is least likely to cover. */}
                            {rest.length > 0 ? (
                              <span style={{ display: 'block', marginTop: 8 }}>
                                {addingField ? (
                                  <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {rest.map((key) => (
                                      <button
                                        key={key}
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => { setAskFields([...askFields, key]); }}
                                      >
                                        + {fieldLabel(key)}
                                      </button>
                                    ))}
                                    <button type="button" className="btn btn-ghost btn-sm"
                                      onClick={() => setAddingField(false)}>
                                      Done
                                    </button>
                                  </span>
                                ) : (
                                  <button type="button" className="btn btn-ghost btn-sm"
                                    onClick={() => setAddingField(true)}>
                                    <Ico.plus w={12} /> Add a field
                                  </button>
                                )}
                              </span>
                            ) : null}
                          </span>
                          );
                        })() : null}
                        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} disabled={resolving}
                          onClick={() => { setActiveResolution(null); setResolutionValue(''); setAskOf(''); setAskFields(null); }}>
                          Cancel
                        </button>
                      </span>
                    );
                  })() : null}
                </span>
                {activeResolution?.flag !== flag.kind && flag.resolutions.length > 0 ? (
                  <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                    {flag.resolutions.map((r) => {
                      // An admin-only action stays visible to everyone, disabled,
                      // with the reason in the tooltip. Hiding it would leave a
                      // reviewer staring at a blocked bill wondering what the
                      // route forward even is.
                      const blocked = r.requires === 'admin' && !canOverrideDuplicate;
                      // The title has to sit on a WRAPPER. Browsers suppress
                      // pointer events on a disabled control, so a tooltip on
                      // the button itself never appears — the one explanation
                      // of why the button is dead was unreachable by hovering
                      // the dead button.
                      const why = blocked
                        ? 'Only a primary admin or admin can do this — ask one to look, or ask a question on this bill.'
                        : r.detail;
                      return (
                        <span key={r.action} title={why} style={{ display: 'inline-flex', flex: 'none' }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ flex: 'none' }}
                            disabled={blocked}
                            aria-label={blocked ? `${r.label} — ${why}` : undefined}
                            onClick={() => startResolution(flag.kind, r.action)}
                          >
                            {r.label}
                          </button>
                        </span>
                      );
                    })}
                  </span>
                ) : null}
              </div>
            ))}

            {/* A document that is not an invoice gets its own screen, not the
                bill form with a warning on top. The flags above still show —
                they carry the actions — but nothing below states that this is
                payable. */}
            {billDraft.notABill ? (
              <NotABillPane notABill={billDraft.notABill} organizationId={organizationId} />
            ) : (
            <>
            {/* Vendor */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Vendor</h2>
                  <p className="sh-desc">
                    {billDraft.vendor.isNew
                      ? 'First bill from this vendor — payment details go through verification.'
                      : 'A vendor you already pay.'}
                  </p>
                </div>
              </div>
              <div className="rev-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
                {/* Hand-rolled rather than DraftField because these two are
                    bound to their own state, not to billDraft.fields — which is
                    why they were the only fields in the vocabulary that could
                    not say they had been asked about. A question naming "the
                    vendor details" pointed at six fields and visibly marked
                    four, missing the two it was most about. */}
                <VendorField
                  label="Vendor name"
                  value={vendorName}
                  state={fields['vendor.name']?.state ?? 'read'}
                  readOnly={readOnly}
                  asked={askedFields.get('vendor.name')}
                  onChange={setVendorName}
                  onConfirm={() => confirmField('vendor.name')}
                  onFocusField={() => setActiveSource(billDraft.vendor.nameSource ?? null)}
                />
                <VendorField
                  label="Email"
                  value={vendorEmail}
                  state={fields['vendor.email']?.state ?? 'read'}
                  readOnly={readOnly}
                  asked={askedFields.get('vendor.email')}
                  onChange={setVendorEmail}
                  onConfirm={() => confirmField('vendor.email')}
                  onFocusField={() => setActiveSource(billDraft.vendor.emailSource ?? null)}
                  placeholder="Not on document"
                />
              </div>
              <div className="rev-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
                {billDraft.remitFields.map((f) => (
                  <DraftField
                    key={f.key}
                    askedBy={askedFields.get(f.key)?.by ?? null}
                    askedQuestion={askedFields.get(f.key)?.question ?? null}
                    def={f}
                    current={fields[f.key]!}
                    readOnly={readOnly}
                    onChange={(v) => setFieldValue(f.key, v)}
                    onConfirm={() => confirmField(f.key)}
                    onFocusField={() => setActiveSource(f.source ?? null)}
                  />
                ))}
              </div>
            </section>

            {/* Bill details — one flat list */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Bill details</h2>
                  <p className="sh-desc">
                    {billDraft.fields.some((f) => f.state === 'needs_look') && !readOnly
                      ? 'A few fields need a look — confirm or correct them.'
                      : 'Everything checks out.'}
                  </p>
                </div>
              </div>
              <div className="rev-grid">
                {billDraft.fields.map((f) => (
                  <DraftField
                    key={f.key}
                    askedBy={askedFields.get(f.key)?.by ?? null}
                    askedQuestion={askedFields.get(f.key)?.question ?? null}
                    def={f}
                    current={fields[f.key]!}
                    readOnly={readOnly}
                    onChange={(v) => setFieldValue(f.key, v)}
                    onConfirm={() => confirmField(f.key)}
                    onFocusField={() => setActiveSource(f.source ?? null)}
                  />
                ))}
              </div>
            </section>

            {/* Lines */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Line items</h2>
                  {billDraft.codingSuggestionSource ? (
                    <p className="sh-desc">Categories pre-filled — {billDraft.codingSuggestionSource.detail}. Change any that look wrong.</p>
                  ) : null}
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setLines((prev) => [...prev, { description: '', quantity: 1, unitPrice: null, amount: null, category: null }])}
                  >
                    <Ico.plus w={14} /> Add a line
                  </button>
                ) : null}
              </div>
              <div className="tbl-card">
                <table className="tbl tbl-slim">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th className="num" style={{ width: 52 }}>Qty</th>
                      <th className="num" style={{ width: 116 }}>Unit</th>
                      <th style={{ width: 220 }}>Category</th>
                      <th className="num" style={{ width: 130 }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={i} onFocus={() => setActiveSource(line.source ?? null)}>
                        <td>
                          <DescriptionInput
                            value={line.description}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, description: v } : l)))}
                          />
                        </td>
                        <td>
                          <input
                            className="tbl-input td-num"
                            value={line.quantity ?? ''}
                            disabled={readOnly}
                            onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, quantity: e.target.value === '' ? null : Number(e.target.value) } : l)))}
                          />
                        </td>
                        <td>
                          <MoneyInput
                            value={line.unitPrice}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, unitPrice: v } : l)))}
                          />
                        </td>
                        <td>
                          <AccountPicker
                            value={line.category ?? ''}
                            options={categoryOptions}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, category: v || null } : l)))}
                          />
                        </td>
                        <td>
                          <MoneyInput
                            value={line.amount}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, amount: v } : l)))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Totals sit exactly under Amount; the arithmetic check sits
                      beside them, not on its own row (per the design). */}
                  <tfoot>
                    <tr
                      onClick={() => setActiveSource(billDraft.totalsSources?.lineItems ?? null)}
                      style={billDraft.totalsSources?.lineItems ? { cursor: 'pointer' } : undefined}
                    >
                      <td colSpan={3} rowSpan={3} className="arith-cell">
                        <span className={`arith-note${arithmeticOk ? '' : ' bad'}`}>
                          {arithmeticOk ? <Ico.checkSm w={13} /> : null}
                          {arithmeticOk
                            ? "Adds up to the document's total"
                            : `Document says ${usd(documentTotal)} · lines add to ${usd(computedTotal)}`}
                        </span>
                      </td>
                      <td className="lt-label">Line items</td>
                      <td className="td-num">{usd(linesTotal)}</td>
                    </tr>
                    <tr onFocus={() => setActiveSource(billDraft.totalsSources?.tax ?? null)}>
                      <td className="lt-label">Tax</td>
                      <td>
                        <MoneyInput value={taxNumber} disabled={readOnly} onChange={(v) => setTax(v == null ? '' : String(v))} />
                      </td>
                    </tr>
                    <tr
                      className="grand"
                      onClick={() => setActiveSource(billDraft.totalsSources?.total ?? null)}
                      style={billDraft.totalsSources?.total ? { cursor: 'pointer' } : undefined}
                    >
                      <td className="lt-label">Total</td>
                      <td className="td-num">{usd(computedTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {!readOnly ? (
              <div className="field">
                <span className="field-label">Note for approvers (optional)</span>
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="One line of context that rides along with the bill"
                  maxLength={500}
                />
              </div>
            ) : billDraft.verification ? (
              <div className="callout">
                <Ico.checkSm w={16} />
                <span>
                  Confirmed and sent for approval
                  {billDraft.verification.confirmedAt ? ` on ${new Date(billDraft.verification.confirmedAt).toLocaleDateString()}` : ''}.
                  {billDraft.verification.noteForApprovers ? ` Note: "${billDraft.verification.noteForApprovers}"` : ''}
                </span>
              </div>
            ) : null}
            </>
            )}

            {/* Outside the not-a-bill branch on purpose: a document somebody
                closed as a statement still had things done to it, and "who
                decided that, and when" is exactly the question asked later. */}
            {billDraft.workLog.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>What's happened to this bill</h2>
                    <p className="sh-desc">
                      Every change and every check that has cleared, in order. Kept from the moment
                      the document arrived, not from the moment it is confirmed.
                    </p>
                  </div>
                </div>
                <BillWorkLog entries={billDraft.workLog} />
              </section>
            ) : null}
          </div>
        </div>

        <div
          className={`rev-divider${dragging ? ' dragging' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
          role="separator"
          aria-orientation="vertical"
        />

        <DocumentPane
          organizationId={organizationId}
          document={billDraft.document}
          activeSource={activeSource}
          width={`${panelPct}%`}
        />
      </div>

      {/* Commit bar */}
      {!readOnly ? (
        <div className="commit-bar">
          <button type="button" className="btn btn-ghost" onClick={() => setNotABillOpen(true)}>
            {/* It usually IS a bill — just not one to pay. The old label made
                you assert something false to get unstuck. */}
            Close this bill
          </button>
          <span className="cb-note">
            {/* Name the flag and point at its own buttons. The old copy —
                "resolve the flagged issue above" — was a promise nothing on the
                page could keep, because resolutions did not exist yet. */}
            {!canEditBills
              ? 'Preparing a bill is the Bill Clerk\u2019s job — you can read it, but not send it for approval.'
              : blockingFlags.length > 0
              ? `${blockingFlags[0]!.short} — use the buttons on that flag to settle it.`
              : tier1Gap ?? 'Recorded with exactly what you see on this screen.'}
          </span>
          <span className="commit-spacer" />
          {/* This button was called "Save for later", which read as a way to
              defer the bill rather than a way to keep what you had typed — and
              for most of the screen's life it kept nothing at all, since it
              only called onBack. It saves now, and it says so — and it leaves
              you on the bill, because saving your work is not the same as
              finishing with it. */}
          <button type="button" className="btn btn-secondary" disabled={saving || !canEditBills}
            onClick={() => void saveChanges()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={() => setConfirmOpen(true)}>
            {submitting ? 'Sending…' : 'Confirm & send for approval'}
          </button>
        </div>
      ) : null}

      {confirmOpen ? (
        <ConfirmDialog
          title="Send this for approval?"
          body={`This records the figures exactly as they are on this screen and puts ${vendorName || 'the bill'} in front of the approvers. Correcting it afterwards restarts their approvals.`}
          confirmLabel="Send for approval"
          busyLabel="Sending…"
          busy={submitting}
          onConfirm={() => { setConfirmOpen(false); void confirm(); }}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}

      {notABillOpen ? (
        <NotABillDialog
          organizationId={organizationId}
          paymentOrderId={billDraft.paymentOrderId}
          onClose={() => setNotABillOpen(false)}
          onDone={() => { setNotABillOpen(false); onDone(); }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

// Money cell: the $ is part of the value ("$2,650.00"), right-aligned as one
// unit; parses loosely while typing, formats on blur.
// A document that is not an invoice, shown as itself rather than as a bill.
//
// Everything arrives here having been read as an invoice, because that is what
// the extractor is asked for. When it turns out to be something else, dressing
// it in the bill form — field grid, coded line items, a Confirm button — states
// that it is payable, which is the one thing it is not. This replaces the form
// entirely, so that somebody who has seen fifty bills knows from the shape of
// the screen, before reading a word, that this one is different.
const NOT_A_BILL: Record<string, { title: string; blurb: string }> = {
  statement: {
    title: 'This is a statement of account',
    blurb: 'It summarises invoices the vendor has already sent. Paying it would pay every one of them again — settle the individual invoices instead.',
  },
  credit_note: {
    title: 'This is a credit note',
    blurb: 'The vendor owes money back. A credit reduces what you owe — it is applied against a bill, never paid out.',
  },
  receipt: {
    title: 'This is a receipt',
    blurb: 'It records a payment already made. Nothing is owed on it.',
  },
  quote: {
    title: 'This is a quote',
    blurb: 'It prices work that has not been invoiced yet. Nothing is owed until an invoice arrives.',
  },
  purchase_order: {
    title: 'This is a purchase order',
    blurb: 'A purchase order is our own paperwork, not a vendor demand for payment.',
  },
  other: {
    title: 'This does not look like an invoice',
    blurb: 'Nothing here reads as a bill from a vendor. Check the document before going further.',
  },
};

function NotABillPane({ notABill, organizationId }: {
  notABill: NonNullable<BillDraft['notABill']>;
  organizationId: string;
}) {
  const copy = NOT_A_BILL[notABill.kind] ?? NOT_A_BILL.other!;
  const st = notABill.statement;

  return (
    <section>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>{copy.title}</h2>
          <p className="sh-desc">{copy.blurb}</p>
        </div>
      </div>

      {notABill.appliesToInvoice ? (
        <div className="callout callout-info" style={{ marginBottom: 16 }}>
          <Ico.doc w={16} />
          <span>Applies to invoice <b>{notABill.appliesToInvoice}</b>.</span>
        </div>
      ) : null}

      {st ? (
        <>
          {/* The reason to read a statement rather than bin it: it names an
              invoice that never reached us, and one we have already settled. */}
          <p className="sh-desc" style={{ marginBottom: 12 }}>
            {st.missing > 0
              ? `${st.missing} of these ${st.rows.length} ${st.missing === 1 ? 'is' : 'are'} not in Decimal — worth chasing the invoice itself.`
              : 'Every invoice on it is already in Decimal.'}
            {st.alreadyPaid > 0
              ? ` The vendor marks ${st.alreadyPaid} of them already paid.`
              : ''}
          </p>
          <div className="tbl-card">
            <table className="tbl tbl-slim">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>They say</th>
                  <th>In Decimal</th>
                </tr>
              </thead>
              <tbody>
                {st.rows.map((r, i) => (
                  <tr key={`${r.reference ?? i}`}>
                    <td className="cell-mono">{r.reference ?? '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.date ?? '—'}</td>
                    <td className="td-num">{r.amountUsd == null ? '—' : usd(r.amountUsd)}</td>
                    <td>
                      <span className={`pill pill-min ${r.statedStatus === 'paid' ? 'pill-success' : r.statedStatus === 'overdue' ? 'pill-danger' : 'pill-neutral'}`}>
                        <span className="dot" />{r.statedStatus ?? 'unknown'}
                      </span>
                    </td>
                    <td>
                      {r.held ? (
                        <a href={`/organizations/${organizationId}/bills/${r.held.paymentOrderId}`}
                          style={{ color: 'var(--accent)' }}>
                          {r.held.where}
                        </a>
                      ) : (
                        <span className="pill pill-min pill-warning"><span className="dot" />not in Decimal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * A line's description, on as many rows as it needs.
 *
 * It was an <input>, and an input is one line by construction: "Social media
 * management — August" rendered as "Social media management — A" with the rest
 * reachable only by putting a cursor in the field and scrolling it sideways.
 * On the screen where somebody is checking what they are about to pay, a
 * description you cannot read is the one field that must never be cut off.
 *
 * A textarea wraps, and grows to fit rather than showing its own scrollbar —
 * the row gets taller, which is what the reader wanted. Enter is swallowed
 * because this is a table cell, not prose: a newline inside a description
 * would travel all the way to the vendor's remittance.
 */
function DescriptionInput(props: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    // Measured while hidden, scrollHeight is 0 — writing that back would
    // collapse the field to nothing, which is a worse bug than the one this
    // fixes. Leave it to the browser until there is a real measurement.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  };

  // On mount and whenever the text changes from outside (the draft loading,
  // an AI re-read), not only on keystrokes.
  useEffect(() => { grow(ref.current); }, [props.value]);

  return (
    <textarea
      ref={ref}
      className="tbl-input tbl-input-wrap"
      rows={1}
      value={props.value}
      disabled={props.disabled}
      placeholder="What is this for?"
      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
      onChange={(e) => { grow(e.currentTarget); props.onChange(e.target.value); }}
    />
  );
}

function MoneyInput(props: { value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  const { value, disabled, onChange } = props;
  const [text, setText] = useState(value == null ? '' : usd(value));
  return (
    <input
      className="tbl-input td-num"
      value={text}
      disabled={disabled}
      placeholder="$0.00"
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^0-9.]/g, '');
        setText(cleaned === '' ? '' : `$${cleaned}`);
        onChange(cleaned === '' ? null : Number(cleaned));
      }}
      onBlur={() => {
        const n = Number(text.replace(/[^0-9.]/g, ''));
        setText(text === '' || Number.isNaN(n) ? '' : usd(n));
      }}
    />
  );
}

// Category is picked from the org's chart of accounts, never typed. A value
// that isn't in the chart (older suggestion, disconnected books) still shows
// as a choice so it isn't silently dropped.
// Design-system account picker (the Ramp pattern): a select-look trigger that
// opens a searchable, scrollable, grouped list — account name with its number
// beneath. Fixed-positioned so table/panel overflow can't clip it.
function AccountPicker(props: {
  value: string;
  options: CategoryOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { value, options, disabled, onChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const all = value && !options.some((o) => o.value === value)
    ? [{ value, label: value, num: null, group: 'Suggestions' }, ...options]
    : options;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((o) => o.label.toLowerCase().includes(q) || (o.num ?? '').toLowerCase().includes(q))
    : all;
  const groups: Array<{ group: string; items: Array<{ option: CategoryOption; index: number }> }> = [];
  filtered.forEach((option, index) => {
    const bucket = groups.find((g) => g.group === option.group);
    if (bucket) bucket.items.push({ option, index });
    else groups.push({ group: option.group, items: [{ option, index }] });
  });

  const openPicker = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 340;
    const openUp = rect.bottom + height + 8 > window.innerHeight && rect.top - height - 8 > 0;
    setPos({
      left: Math.min(rect.left, window.innerWidth - 308),
      top: openUp ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
    });
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Fixed positioning goes stale when the panel scrolls — just close.
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const selected = all.find((o) => o.value === value) ?? null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="picker-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <span className={`pt-label${selected ? '' : ' placeholder'}`}>
          {selected ? (selected.num ? `${selected.num} · ${selected.label}` : selected.label) : 'Pick an account'}
        </span>
        <Ico.chevDown w={12} />
      </button>
      {open && pos ? (
        <div className="picker-pop" ref={popRef} style={{ left: pos.left, top: pos.top }} role="listbox">
          <div className="picker-search">
            <Ico.search w={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search accounts"
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const target = filtered[activeIndex];
                  if (target) pick(target.value);
                }
              }}
            />
          </div>
          <div className="picker-list">
            {filtered.length === 0 ? (
              <div className="picker-empty">No account matches "{query}".</div>
            ) : (
              groups.map((g) => (
                <div key={g.group}>
                  <div className="picker-group">{g.group}</div>
                  {g.items.map(({ option, index }) => (
                    <button
                      type="button"
                      key={option.value}
                      className={`picker-item${option.value === value ? ' on' : ''}${index === activeIndex ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => pick(option.value)}
                    >
                      <span className="pi-name">{option.label}</span>
                      {option.num ? <span className="pi-num">{option.num}</span> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

// The vendor name and email, which hold their value in their own state rather
// than in billDraft.fields — so they cannot be DraftFields, but must not look
// like a different kind of thing either. Same markers, same words, same Confirm.
//
// The first version of this had no Confirm and its own wording, on the grounds
// that these fields had nowhere to confirm TO. That was true and it was the
// wrong conclusion: the fix is to give them somewhere, not to give the person
// looking at them a second vocabulary to learn.
function VendorField(props: {
  label: string;
  value: string;
  state: BillDraftField['state'];
  readOnly: boolean;
  asked?: { by: string; question: string };
  onChange: (value: string) => void;
  onConfirm: () => void;
  onFocusField: () => void;
  placeholder?: string;
}) {
  const { label, value, state, readOnly, asked, onChange, onConfirm, onFocusField, placeholder } = props;
  const needsLook = state === 'needs_look';
  return (
    <div className="rev-field">
      <span className="field-label">{label}</span>
      <input
        className={`input${needsLook || asked ? ' is-look' : ''}`}
        value={value}
        disabled={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocusField}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (needsLook || asked)) {
            e.preventDefault();
            onConfirm();
          }
        }}
      />
      {state === 'confirmed' ? (
        <span className="ftag is-confirmed"><Ico.checkSm w={11} /> Confirmed by you</span>
      ) : asked ? (
        <span className="ftag is-look" title={asked.question}>
          Asked ·{' '}
          {!readOnly ? (
            <button type="button" className="ftag-btn" onClick={onConfirm}>Confirm</button>
          ) : null}
        </span>
      ) : needsLook ? (
        <span className="ftag is-look" title="Worth a second look before this is paid">
          Check ·{' '}
          {!readOnly ? (
            <button type="button" className="ftag-btn" onClick={onConfirm}>Confirm</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function DraftField(props: {
  def: BillDraftField;
  current: { value: string; state: BillDraftField['state'] };
  readOnly: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onFocusField?: () => void;
  /** Set when an outstanding question named this field. */
  askedBy?: string | null;
  /** The question itself, shown on hover rather than printed under every field. */
  askedQuestion?: string | null;
}) {
  const { def, current, readOnly, onChange, onConfirm, onFocusField, askedBy, askedQuestion } = props;
  const needsLook = current.state === 'needs_look';
  // Reuse the amber "needs attention" state rather than inventing a second
  // visual language for the same idea: this field wants a human's eye.
  return (
    <div className="rev-field">
      <span className="field-label">{def.label}</span>
      <input
        className={`input${needsLook || askedBy ? ' is-look' : ''}`}
        value={current.value}
        disabled={readOnly}
        placeholder={current.state === 'not_on_document' ? 'Not on document' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocusField}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && needsLook) {
            e.preventDefault();
            onConfirm();
          }
        }}
      />
      {/* ONE note per field, never two stacked.
          These fields sit four to a row, so a sentence wraps to three lines and
          repeats across every column. Worse, they had different authors: "Zaid
          asked about this" is a colleague waiting, while "the document was hard
          to read here" is OUR uncertainty — phrased as if the reader had been
          present when we read it. To someone who was asked a question, that
          second line is noise they cannot act on.
          So: one word, and the detail on hover. A question outranks our own
          uncertainty, because a person waiting is more actionable than a low
          confidence score, and the top banner already says who asked what. */}
      {current.state === 'confirmed' ? (
        <span className="ftag is-confirmed"><Ico.checkSm w={11} /> Confirmed by you</span>
      ) : askedBy ? (
        <span className="ftag is-look" title={askedQuestion ?? `${askedBy} asked about this`}>
          Asked ·{' '}
          {!readOnly ? (
            <button type="button" className="ftag-btn" onClick={onConfirm}>Confirm</button>
          ) : null}
        </span>
      ) : needsLook ? (
        <span className="ftag is-look" title={def.reason ?? 'Worth a second look before this is paid'}>
          Check ·{' '}
          {!readOnly ? (
            <button type="button" className="ftag-btn" onClick={onConfirm}>Confirm</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// Zoom is relative to the pane: 100% = the page fits the pane width exactly.
// ±10 points per click; every step visibly changes the render.
const ZOOM_MIN_PCT = 50;
const ZOOM_MAX_PCT = 300;

// The document rendered as clean page images — never a PDF viewer.
export function DocumentPane(props: {
  organizationId: string;
  document: BillDraft['document'] | null;
  // While processing, the caller passes a live pagesStored count so pages
  // appear as soon as they exist.
  pagesStored?: number;
  // Where the focused field was read from — highlighted on the page.
  activeSource?: DocSource;
  // Pane width within the split (the wrapper owns it now).
  width: string;
  /**
   * Open showing the whole first page rather than filling the width.
   *
   * In the split view the document sits beside the fields and the reader is
   * working down it, so filling the width is right. Opened on its own to be
   * looked at — "View invoice" — the first thing wanted is the whole page,
   * and a tall one (A3, or any long invoice) otherwise arrives cropped with
   * its total below the fold, needing several clicks on minus before it can
   * be read at all.
   */
  fitPageOnOpen?: boolean;
}) {
  const { organizationId, document: doc, activeSource, width } = props;
  const [pageUrls, setPageUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  // Two numbers, because the percentage is a promise to the reader.
  //
  //   basePct  — the page's width, as a share of the scroller, at 100%
  //   scalePct — what the reader sees and drives with the buttons
  //
  // 100% has to mean "the view you were given", or the default reads as
  // something already shrunk: the drawer opened correctly fitted and announced
  // 82%, inviting a hunt for the missing 18%. What differs between the two
  // places this pane appears is only what 100% is anchored to — filling the
  // width in the split, the whole page in the drawer — and that is basePct.
  const [basePct, setBasePct] = useState(100);
  const [scalePct, setScalePct] = useState(100);
  const widthPct = (basePct * scalePct) / 100;
  const knownPages = props.pagesStored ?? doc?.pageCount ?? 0;
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(false);

  // Anchor 100% to the whole page: find the width, as a share of the scroller,
  // at which one page fits the visible box, and call that the baseline. The
  // image keeps its aspect ratio inside that width, so its own proportions are
  // all the arithmetic needs.
  const fitWholePage = (img: HTMLImageElement) => {
    const box = scrollRef.current;
    if (!box || !img.naturalWidth || !img.naturalHeight) return;
    const style = getComputedStyle(box);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availW = box.clientWidth - padX;
    const availH = box.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return;
    const ratio = img.naturalHeight / img.naturalWidth;
    const pct = Math.floor((availH / (availW * ratio)) * 100);
    // A box that has not been laid out yet yields NaN, which would reach the
    // DOM as width:"NaN%" and blank the page. Leaving the zoom alone just
    // means filling the width, which is what it did before any of this.
    if (!Number.isFinite(pct)) return;
    // Never past filling the width: a short page should not be blown up to
    // fill a tall drawer just because there is room.
    setBasePct(Math.max(1, Math.min(100, pct)));
    setScalePct(100);
  };

  // Bring the highlighted region into view when focus moves.
  useEffect(() => {
    if (!activeSource) return;
    const el = pageRefs.current[activeSource.page - 1];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeSource]);

  useEffect(() => {
    if (!doc || knownPages <= 0) return;
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      try {
        for (let i = 0; i < knownPages; i += 1) {
          const url = await invoiceIntakeApi.fetchPageObjectUrl(organizationId, doc.invoiceDocumentId, i);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.push(url);
          setPageUrls([...urls]);
        }
      } catch {
        if (!cancelled && urls.length === 0) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [organizationId, doc?.invoiceDocumentId, knownPages]);

  const zoomBy = (delta: number) => setScalePct((p) => Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, p + delta)));
  const resetView = () => {
    // "Fit to view" re-measures rather than restoring a remembered number, so
    // it still does the right thing after the window has been resized.
    const firstImg = props.fitPageOnOpen
      ? pageRefs.current[0]?.querySelector('img') ?? null
      : null;
    if (firstImg) fitWholePage(firstImg);
    else { setBasePct(100); setScalePct(100); }
    pageRefs.current[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  let content: React.ReactNode;
  if (!doc) {
    content = (
      <div className="empty" style={{ margin: 'auto' }}>
        <span className="empty-icon"><Ico.doc w={22} /></span>
        <h4>No document on file</h4>
        <p>This bill was created before documents were stored.</p>
      </div>
    );
  } else if (failed) {
    content = (
      <div className="empty" style={{ margin: 'auto' }}>
        <span className="empty-icon"><Ico.doc w={22} /></span>
        <h4>Couldn't load the document</h4>
        <p>{doc.filename}</p>
      </div>
    );
  } else if (pageUrls.length === 0) {
    content = <div className="skeleton" style={{ width: '100%', maxWidth: 620, aspectRatio: '8.5 / 11' }} />;
  } else {
    content = (
    <>
      {pageUrls.map((url, i) => (
        <div
          key={i}
          className="doc-page"
          ref={(el) => { pageRefs.current[i] = el; }}
          style={{ width: `${widthPct}%` }}
        >
          <img
            src={url}
            alt={`${doc.filename} — page ${i + 1}`}
            // Only once, and only off the first page: re-fitting on every load
            // would yank the zoom back while someone is reading page four.
            onLoad={(e) => {
              if (i !== 0 || !props.fitPageOnOpen || fittedRef.current) return;
              fittedRef.current = true;
              fitWholePage(e.currentTarget);
            }}
          />
          {activeSource && activeSource.page - 1 === i ? (
            <div
              className="doc-hl"
              style={{
                left: `${activeSource.box[0] * 100}%`,
                top: `${activeSource.box[1] * 100}%`,
                width: `${Math.max(activeSource.box[2] * 100, 1.5)}%`,
                height: `${Math.max(activeSource.box[3] * 100, 1)}%`,
              }}
            />
          ) : null}
        </div>
      ))}
    </>
    );
  }

  return (
    <div className="rev-doc-wrap" style={{ width }}>
      {doc ? (
        <div className="doc-head">
          <div className="dh-file">
            <Ico.doc w={15} />
            <span className="dh-name">{doc.filename}</span>
            {knownPages > 0 ? (
              <span className="kbd">{knownPages} page{knownPages === 1 ? '' : 's'}</span>
            ) : null}
          </div>
          <div className="dh-zoom">
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom out" onClick={() => zoomBy(-10)} disabled={scalePct <= ZOOM_MIN_PCT}>
              <Ico.minus w={13} />
            </button>
            <span className="dh-pct">{scalePct}%</span>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom in" onClick={() => zoomBy(10)} disabled={scalePct >= ZOOM_MAX_PCT}>
              <Ico.plus w={13} />
            </button>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Fit to view" onClick={resetView}>
              <Ico.expand w={12} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="rev-doc" ref={scrollRef}>{content}</div>
    </div>
  );
}

// Live intake: the operator lands here the moment the upload finishes. The
// document shows immediately; the read panel fills in when the read completes.
export function DocumentDraftPage() {
  const { organizationId = '', invoiceDocumentId = '' } = useParams();
  const navigate = useNavigate();

  const status = useQuery({
    queryKey: ['invoice-document-status', organizationId, invoiceDocumentId],
    queryFn: () => invoiceIntakeApi.status(organizationId, invoiceDocumentId),
    enabled: Boolean(organizationId && invoiceDocumentId),
    // Poll until a TERMINAL state — and keep polling in background/agent-driven
    // tabs (React Query pauses intervals for "hidden" tabs by default, which
    // left the skeleton up long after extraction finished — testbench 002 §1).
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'processed' || s === 'failed' ? false : 1200;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const data = status.data;

  // Read complete → swap to the real draft of the first created bill.
  useEffect(() => {
    if (data?.status === 'processed' && data.paymentOrders[0]) {
      navigate(
        `/organizations/${organizationId}/bills/${data.paymentOrders[0].paymentOrderId}/draft`,
        { replace: true },
      );
    }
  }, [data?.status, data?.paymentOrders, navigate, organizationId]);

  const docForPane = data
    ? {
        invoiceDocumentId: data.invoiceDocumentId,
        filename: data.filename,
        mimeType: data.mimeType,
        byteSize: 0,
        pageCount: data.pageCount,
      }
    : null;

  return (
    <div className="rev-shell">
      <div className="topbar">
        <div className="tb-context">
          <button
            type="button"
            className="btn btn-ghost tb-back"
            onClick={() => navigate(`/organizations/${organizationId}/bills`)}
          >
            <Ico.chevLeft w={15} /> Bills
          </button>
        </div>
        <div className="tb-right">
          {data?.status === 'processing' ? (
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Reading the document…</span>
          ) : null}
        </div>
      </div>
      <div className="rev-split">
        <div className="rev-panel" style={{ width: '62%' }}>
          {data?.status === 'failed' ? (
            <div className="stack stack-20">
              <div className="callout callout-danger">
                <Ico.shield w={16} />
                <span>
                  We couldn't turn this document into a bill.
                  {data.processingError ? ` ${data.processingError}` : ''}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => navigate(`/organizations/${organizationId}/bills`)}
                >
                  Back to bills
                </button>
              </div>
            </div>
          ) : (
            <div className="stack stack-20" aria-busy="true">
              <div className="skeleton" style={{ height: 68 }} />
              <div className="rev-grid">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="rev-field">
                    <div className="skeleton" style={{ height: 12, width: '60%' }} />
                    <div className="skeleton" style={{ height: 36 }} />
                  </div>
                ))}
              </div>
              <div className="skeleton" style={{ height: 160 }} />
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Reading the document — the fields fill in as soon as we're done.
              </p>
            </div>
          )}
        </div>
        <div className="rev-divider" role="separator" aria-orientation="vertical" />
        <DocumentPane
          organizationId={organizationId}
          document={docForPane}
          pagesStored={data?.pagesStored}
          width="38%"
        />
      </div>
    </div>
  );
}

function NotABillDialog(props: {
  organizationId: string;
  paymentOrderId: string;
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [reason, setReason] = useState<'duplicate' | 'statement' | 'not_ours' | 'unreadable' | 'other'>('duplicate');
  const [detail, setDetail] = useState('');
  const [running, setRunning] = useState(false);

  const reasons: Array<{ key: typeof reason; label: string }> = [
    { key: 'duplicate', label: "It's a duplicate of a bill we already have" },
    { key: 'statement', label: "It's a statement or receipt, not an invoice" },
    { key: 'not_ours', label: "It isn't ours to pay" },
    { key: 'unreadable', label: "It can't be read" },
    { key: 'other', label: 'Something else' },
  ];

  const submit = async () => {
    setRunning(true);
    try {
      await billsApi.notABill(props.organizationId, props.paymentOrderId, { reason, note: detail.trim() || null });
      props.toast.success('Removed from the queue', "It won't be paid.");
      props.onDone();
    } catch (err) {
      props.toast.error('Could not remove', err instanceof Error ? err.message : 'Try again.');
      setRunning(false);
    }
  };

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => { if (e.target === e.currentTarget && !running) props.onClose(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 480 }}>
        <div className="dialog-head">
          <div>
            <h2>This isn't a bill</h2>
            <p>Tell us why — it comes out of the queue and won't be paid.</p>
          </div>
          <button type="button" className="drawer-x" onClick={props.onClose} disabled={running} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div className="check-list">
            {reasons.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`check-item${reason === r.key ? ' on' : ''}`}
                onClick={() => setReason(r.key)}
              >
                <span className="check-box">{reason === r.key ? <Ico.checkSm w={11} /> : null}</span>
                <span className="ci-name">{r.label}</span>
              </button>
            ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">Anything else? (optional)</span>
            <input className="input" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={500} />
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={running}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={submit} disabled={running}>
            {running ? 'Removing…' : 'Remove from queue'}
          </button>
        </div>
      </div>
    </div>
  );
}
