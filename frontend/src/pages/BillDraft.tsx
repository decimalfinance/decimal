// Invoice billDraft — verify what was read from the document, then send for
// approval (uploads/ap-claude-code-handoff.md §3). Document left, one flat
// field list right, user-resizable split, sticky commit bar.
//
// Design rulings preserved: per-field read markers (no confidence sections),
// resizable split (never fixed %), payment details read-only from this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  api,
  billsApi,
  invoiceIntakeApi,
  type BillDraft,
  type BillDraftField,
  type BillDraftLine,
  type CategoryOption,
  type ConfirmBillBody,
  type DocSource,
} from '../api';
import { Ico } from '../dec/icons';
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

  // Prev/next walks the Needs-billDraft queue.
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
      canOverrideDuplicate={Boolean(myAccess.data?.isOwnerOrAdmin)}
      onBack={() => navigate(`/organizations/${organizationId}/bills`)}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
        void queryClient.invalidateQueries({ queryKey: ['bill-billDraft', organizationId, paymentOrderId] });
        const next = queue.find((id) => id !== paymentOrderId);
        if (next) navigate(`/organizations/${organizationId}/bills/${next}/draft`);
        else navigate(`/organizations/${organizationId}/bills`);
      }}
      toast={toast}
    />
  );
}

function DraftScreen(props: {
  organizationId: string;
  billDraft: BillDraft;
  canOverrideDuplicate: boolean;
  onBack: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { organizationId, billDraft, canOverrideDuplicate, onBack, onDone, toast } = props;
  const readOnly = billDraft.readOnly;
  const queryClient = useQueryClient();

  // Flag resolutions. One mechanism for every flag rather than a bespoke path
  // per kind — the backend says which are available and who may take them, so
  // this only has to run the one the person chose.
  type ResolutionAction = 'this_is_us' | 'not_ours' | 'ask_someone' | 'clear_duplicate' | 'fix_fields' | 'raise_ceiling' | 'release_vendor';
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

  const suggestFields = async (question: string) => {
    if (question.trim().length < 3) return;
    setSuggesting(true);
    try {
      const res = await billsApi.suggestAskFields(organizationId, billDraft.paymentOrderId, question.trim());
      setAskFields(res.fields);
      setSuggestionId(res.suggestionId);
    } catch {
      setAskFields([]); // no suggestion is fine; the question still sends
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
  const [showThread, setShowThread] = useState(false);
  const openQuestions = billDraft.questions.filter((q) => q.stillOpen).length;

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
  const askCandidates = useQuery({
    queryKey: ['ask-candidates', organizationId, billDraft.paymentOrderId],
    queryFn: () => billsApi.askCandidates(organizationId, billDraft.paymentOrderId),
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
          help: 'Confirm the name below. It is recorded against your organization, so bills addressed to it are never flagged again — and only an owner or admin can do this.',
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
      setSuggestionId(null);
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
        });
        toast.success('Asked. The bill waits on their answer rather than moving on.', 'Question sent');
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
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notABillOpen, setNotABillOpen] = useState(false);
  // Field ↔ document linking: focusing a field highlights where it was read.
  const [activeSource, setActiveSource] = useState<DocSource>(null);

  // Chart of accounts for the category picker — same source and cache as the
  // coding inbox. Falls back to the billDraft packet's options, then to whatever
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
    // to the billDraft packet's options (builtin chart when QBO isn't connected).
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
  const canConfirm = !readOnly && blockingFlags.length === 0 && !submitting && !tier1Gap;

  // --- commit ---------------------------------------------------------------
  const confirm = useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const body: ConfirmBillBody = {
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
      };
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
  }, [canConfirm, fields, lines, documentTotal, taxNumber, note, vendorName, vendorEmail, organizationId, billDraft.paymentOrderId, toast, onDone]);

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
          {/* Who put this bill here — a reviewer's first question when a bill
              they didn't upload appears in their queue. */}
          {billDraft.source === 'email' && billDraft.sourceLabel ? (
            <span className="cell-source" style={{ marginLeft: 12 }}>
              <Ico.mail w={15} />
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{billDraft.sourceLabel}</span>
            </span>
          ) : null}
        </div>

      </div>

      {/* Split: read panel LEFT, document RIGHT (matches the approved mock). */}
      <div className="rev-split">
        <div className="rev-panel" style={{ width: `${100 - panelPct}%` }}>
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
            {billDraft.route.length > 0 ? (
              <div style={{ margin: '-20px -24px 0', padding: '12px 24px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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

                {/* A conversation, not a stack of alert boxes. Each exchange is
                    one line you can scan — who asked whom, and whether it is
                    settled — with the detail folded away underneath. */}
                {billDraft.questions.filter((q) => showThread || (q.youWereAsked && q.stillOpen)).map((q) => {
                  const settled = q.outcome === 'answered';
                  const fields = q.openFields.length ? q.openFields : q.highlightFields;
                  return (
                    <div
                      key={q.billQuestionId}
                      style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}
                      // Hovering an exchange lights the fields it is about, so
                      // "which bits does this concern" needs no reading.
                      onMouseEnter={() => setHoveredQuestion(q.billQuestionId)}
                      onMouseLeave={() => setHoveredQuestion(null)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong>{q.askedByName}</strong>
                        <span style={{ color: 'var(--text-muted)' }}>asked</span>
                        <strong>{q.askedOfName}</strong>
                        <span className={`pill pill-min ${settled ? 'pill-success' : 'pill-warning'}`}>
                          <span className="dot" />
                          {settled ? `${q.askedOfName.split(' ')[0]} confirmed these details`
                            : q.outcome === 'partial' ? 'Partly answered'
                            : q.outcome === 'forwarded' ? 'Passed on'
                            : q.outcome === 'handed_back' ? `${q.askedOfName.split(' ')[0]} could not answer`
                            : `Waiting on ${q.askedOfName.split(' ')[0]}`}
                        </span>
                        <span style={{ flex: 1 }} />
                        {fields.length > 0 ? (
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => setOpenThreadDetail(openThreadDetail === q.billQuestionId ? null : q.billQuestionId)}>
                            {fields.length} field{fields.length === 1 ? '' : 's'}
                            <Ico.chevDown w={12} style={{ marginLeft: 4, transform: openThreadDetail === q.billQuestionId ? 'rotate(180deg)' : undefined }} />
                          </button>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 4 }}>“{q.question}”</div>
                      {q.answer ? (
                        <div style={{ marginTop: 2, color: 'var(--text-muted)' }}>
                          <strong>{q.askedOfName.split(' ')[0]}:</strong> “{q.answer}”
                        </div>
                      ) : null}

                      {openThreadDetail === q.billQuestionId && fields.length > 0 ? (
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {fields.map((f) => (
                            <span key={f} className="pill pill-min pill-neutral">{fieldLabel(f)}</span>
                          ))}
                        </div>
                      ) : null}

                      {q.youWereAsked && answerFor === q.billQuestionId ? null : q.youWereAsked ? (
                        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}
                          onClick={() => { setAnswerFor(q.billQuestionId); setAnswerText(''); setSettled([]); }}>
                          Answer
                        </button>
                      ) : null}
                    </div>
                  );
                })}
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
                                style={{ flex: '0 0 200px', height: 32 }}>
                                <option value="">Choose a colleague…</option>
                                {people.map((c) => (
                                  <option key={c.userId} value={c.userId}>
                                    {c.name}{c.answered > 0 ? ` — answered ${c.answered}` : ''}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            <input
                              className="input"
                              autoFocus={!asking}
                              value={resolutionValue}
                              placeholder={asking ? 'What do you want to know?' : ask!.label}
                              onChange={(e) => setResolutionValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && ready) void runResolution(); }}
                              style={{ flex: 1, minWidth: 0, height: 32 }}
                            />
                            <button type="button" className="btn btn-primary btn-sm" style={{ flex: 'none' }}
                              disabled={resolving || !ready || (asking && suggesting)}
                              onClick={() => {
                                // Two steps on purpose: suggest, then confirm.
                                // The asker sees exactly what the other person
                                // will be pointed at before it is sent.
                                if (asking && askFields === null) { void suggestFields(resolutionValue); return; }
                                void runResolution();
                              }}>
                              {resolving ? 'Saving…'
                                : asking && suggesting ? 'Reading…'
                                : asking && askFields === null ? 'Next'
                                : asking ? 'Ask' : ask!.cta}
                            </button>
                          </span>
                        )}
                        {asking && askFields !== null ? (
                          <span style={{ display: 'block', marginTop: 10 }}>
                            <strong style={{ display: 'block' }}>
                              {askFields.length > 0
                                ? 'These are the fields they will be asked to fill — right?'
                                : 'This does not look like it is about a specific field.'}
                            </strong>
                            <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
                              {askFields.length > 0
                                ? 'They will be highlighted on their screen. Untick anything that does not belong.'
                                : 'It will be sent as a plain question, with nothing highlighted.'}
                            </span>
                            {askFields.length > 0 ? (
                              <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                                {askFields.map((key) => (
                                  <label key={key} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                    <input type="checkbox" checked
                                      onChange={() => setAskFields(askFields.filter((k) => k !== key))} />
                                    {fieldLabel(key)}
                                  </label>
                                ))}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
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
                      return (
                        <button
                          key={r.action}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ flex: 'none' }}
                          disabled={blocked}
                          title={blocked ? 'Only an owner or admin can do this — ask one to look, or ask a question on this bill.' : r.detail}
                          onClick={() => startResolution(flag.kind, r.action)}
                        >
                          {r.label}
                        </button>
                      );
                    })}
                  </span>
                ) : null}
              </div>
            ))}

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
                <div className="rev-field">
                  <span className="field-label">Vendor name</span>
                  <input
                    className="input"
                    value={vendorName}
                    disabled={readOnly}
                    onFocus={() => setActiveSource(billDraft.vendor.nameSource ?? null)}
                    onChange={(e) => setVendorName(e.target.value)}
                  />
                </div>
                <div className="rev-field">
                  <span className="field-label">Email</span>
                  <input
                    className="input"
                    value={vendorEmail}
                    disabled={readOnly}
                    placeholder="Not on document"
                    onFocus={() => setActiveSource(billDraft.vendor.emailSource ?? null)}
                    onChange={(e) => setVendorEmail(e.target.value)}
                  />
                </div>
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
                          <input
                            className="tbl-input"
                            value={line.description}
                            disabled={readOnly}
                            placeholder="What is this for?"
                            onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)))}
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
            {blockingFlags.length > 0
              ? `${blockingFlags[0]!.short} — use the buttons on that flag to settle it.`
              : tier1Gap ?? 'Recorded with exactly what you see on this screen.'}
          </span>
          <span className="commit-spacer" />
          <button type="button" className="btn btn-secondary" onClick={onBack}>Save for later</button>
          <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
            {submitting ? 'Sending…' : 'Confirm & send for approval'}
          </button>
        </div>
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
}) {
  const { organizationId, document: doc, activeSource, width } = props;
  const [pageUrls, setPageUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const knownPages = props.pagesStored ?? doc?.pageCount ?? 0;
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);

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

  const zoomBy = (delta: number) => setZoomPct((p) => Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, p + delta)));
  const resetView = () => {
    setZoomPct(100);
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
          style={{ width: `${zoomPct}%` }}
        >
          <img src={url} alt={`${doc.filename} — page ${i + 1}`} />
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
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom out" onClick={() => zoomBy(-10)} disabled={zoomPct <= ZOOM_MIN_PCT}>
              <Ico.minus w={13} />
            </button>
            <span className="dh-pct">{zoomPct}%</span>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom in" onClick={() => zoomBy(10)} disabled={zoomPct >= ZOOM_MAX_PCT}>
              <Ico.plus w={13} />
            </button>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Fit to view" onClick={resetView}>
              <Ico.expand w={12} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="rev-doc">{content}</div>
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

  // Read complete → swap to the real billDraft of the first created bill.
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
