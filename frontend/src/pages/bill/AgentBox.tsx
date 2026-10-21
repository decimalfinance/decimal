// The agent box (5a, 26a–29j, 41a): Decimal's word on the bill and the
// conversation under it, in one cloudy pink box that folds. Decimal says what
// it found (or that there is nothing to flag); the ways to settle a finding
// sit at the end of the reply line, and each opens a confirmation card in the
// conversation. What people do is written as their own message: Decimal never
// adds one affirming it. The reply line talks to Decimal, or with an @name
// asks a colleague.
//
// The conversation is a group chat (5b, 5c; Zaid, 2026-10-21). A question is
// its asker's message, "@name" and the words, and nothing is clicked to answer
// it: whoever knows says so, and Decimal judges whether that answered it. The
// person asked sees the question on a maroon band, everyone else sees a row
// for whoever it still waits on, and a finished question says, in one grey
// line, who answered it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  billsApi,
  companionApi,
  type AskCandidate,
  type BillCompanionNote,
  type BillDetail,
  type CompanionActionCard,
  type CompanionChat,
} from '../../api';
import { Avatar } from '../../kit/Avatar';
import { useDismiss } from '../../kit/hooks';
import { useToaster } from '../../kit/Toast';
import { firstName } from '../../kit/format';
import { ActionPills, ConfirmCard, FindingText, pillsFor, type Access, type CardResult, type OpenCard, type Pill } from './Findings';
import { closeReasonFor, findingsOf, linesSum, notesOf, parseMoney, restingMessage, type Face, type Fields, type Flag, type LineEntry } from './model';
import { Chevron, FaceOf, Figures, Mark, Markdown, WaitBadge, chatTime } from './parts';
import { AskCard, isAskCard } from './AskCard';

type Said = {
  id: string;
  at: Date;
  who: Face | 'decimal';
  body: ReactNode;
  sub?: ReactNode;
  live?: boolean;
  cards?: CompanionActionCard[];
  /** A question put to the viewer and still open: the asker's message on the maroon band. */
  forYou?: boolean;
  /** Whoever a question still waits on: their face with the yellow badge. */
  waiting?: boolean;
  /** The viewer's message on its way. */
  sending?: boolean;
};

const quoted = (text: string) => /“(.*)”\s*$/.exec(text)?.[1] ?? null;
const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Everything people (and Decimal, in the viewer's chat) said on this bill, oldest first. */
function threadOf(detail: BillDetail, chat: CompanionChat | undefined, viewer: Face, faces: Map<string, string | null>, lines: LineEntry[]): Said[] {
  const draft = detail.draft;
  const out: Said[] = [];
  const face = (name: string | null | undefined): Face | 'decimal' =>
    !name || name === 'Decimal' ? 'decimal' : { name, avatarUrl: faces.get(name) ?? null };
  const figuresRaised = draft.workLog.some((e) => e.kind === 'flag_raised' && /add up|reconcile/i.test(e.text));
  const itemised = draft.flags.find((f) => f.kind === 'short_paid' && f.severity === 'info');
  const cleared = draft.flags.find((f) => f.kind === 'possible_duplicate' && f.severity === 'info');
  const stillWrong = draft.flags.some((f) => f.kind === 'lines_do_not_sum' || f.kind === 'total_does_not_reconcile');

  for (const e of draft.workLog) {
    const at = new Date(e.at);
    if (e.kind === 'policy_overridden' && e.byName) {
      const reason = quoted(e.text);
      if (e.rule === 'pay_the_itemised_total') {
        const m = itemised ? /Paying the (\$[\d,.]+) this bill itemises rather than the (\$[\d,.]+) printed/.exec(itemised.message) : null;
        out.push({
          id: e.id, at, who: face(e.byName),
          body: <Figures text={`${m ? `Using the ${m[1]} the lines add up to, not the ${m[2]} printed.` : 'Using the itemised total.'}${reason ? ` ${reason}` : ''}`} />,
          sub: 'Settled · the approvers will see this note',
        });
      } else if (e.rule === 'duplicate_bill') {
        const other = cleared ? /duplicate of (invoice \S+|another bill)/.exec(cleared.message)?.[1] : null;
        out.push({
          id: e.id, at, who: face(e.byName),
          body: <Figures text={`Not a duplicate${other ? ` of ${other.replace(/^invoice /, '')}` : ''}.${reason ? ` ${reason}` : ''}`} />,
          sub: 'Settled · both bills can go ahead',
        });
      } else if (e.rule === 'bill_ceiling') {
        out.push({
          id: e.id, at, who: face(e.byName),
          body: <Figures text={`Allowing this bill past the bill limit.${reason ? ` ${reason}` : ''}`} />,
          sub: 'Settled · this bill only; the limit itself is unchanged',
        });
      } else if (e.rule === 'similar_vendor' && reason) {
        out.push({
          id: e.id, at, who: face(e.byName),
          body: capitalise(reason.replace(new RegExp(`^${e.byName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} confirmed\\s+`), '')),
          sub: 'Settled',
        });
      }
    } else if (e.kind === 'field_changed' && e.field === 'total' && e.byName && e.byName !== 'Decimal' && figuresRaised) {
      const m = /changed from (.*) to (.*)$/.exec(e.text);
      // Using the itemised total rewrites the total too; that decision is its own row.
      const partOfItemised = draft.workLog.some((o) =>
        o.kind === 'policy_overridden' && o.rule === 'pay_the_itemised_total' && o.byName === e.byName
        && Math.abs(new Date(o.at).getTime() - at.getTime()) <= 5000);
      if (!m || partOfItemised) continue;
      const to = parseMoney(m[2]);
      const sum = Math.round((linesSum(lines) + (parseMoney(String(draft.taxAmount ?? 0)) ?? 0)) * 100) / 100;
      out.push({
        id: e.id, at, who: face(e.byName),
        body: <Figures text={`The total was read from the document as ${m[1]}. I changed it to ${m[2]}${to === sum ? ', which is what the lines add up to' : ''}.`} />,
        sub: stillWrong ? 'Figures changed' : 'Figures changed · settled: the lines and the total agree',
      });
    }
  }

  for (const t of draft.tradingNamesFromHere ?? []) {
    if (!t.byName || !t.at) continue;
    out.push({
      id: `tn-${t.name}`, at: new Date(t.at), who: face(t.byName),
      body: `${t.name} is a name we trade under.`,
      sub: 'Settled · bills addressed to it aren’t flagged again',
    });
  }

  // A question is its asker's message. An answer said in the conversation is
  // already in the thread as that person's message, and a deed has no words,
  // so the question only says who answered it. Words typed into the old answer
  // box, or a note closing it, aren't in the thread yet: they become a message.
  for (const q of draft.questions) {
    const by = q.answeredByName ?? 'Someone';
    const next = q.outcome === 'forwarded' ? draft.questions.find((x) => x.forwardedFromQuestionId === q.billQuestionId) : null;
    // A question passed on was raised in the same instant as the words that
    // passed it on: it follows them.
    const from = q.forwardedFromQuestionId ? draft.questions.find((x) => x.billQuestionId === q.forwardedFromQuestionId) : null;
    const askedAt = Math.max(new Date(q.askedAt).getTime(), from?.answeredAt ? new Date(from.answeredAt).getTime() + 1 : 0);
    out.push({
      id: `q-${q.billQuestionId}`, at: new Date(askedAt), who: face(q.askedByName),
      body: <><span className="at">@{q.askedOfName}</span> <Figures text={q.question} /></>,
      sub: q.stillOpen ? (q.youWereAsked ? 'Question for you' : undefined)
        : q.outcome === 'handed_back' ? `${by} couldn’t answer`
        : q.outcome === 'closed' ? `Closed by ${by}`
        : q.outcome === 'forwarded' ? `${by} passed it on${next ? ` to ${next.askedOfName}` : ''}`
        : q.outcome === 'partial' ? `Partly answered by ${by}`
        : q.answerVia === 'deed' && q.answer ? <Figures text={`Answered · ${q.answer}`} />
        : `Answered by ${by}`,
      forYou: q.stillOpen && q.youWereAsked,
    });
    if (q.answer?.trim() && q.answeredAt && q.answerVia !== 'message' && q.answerVia !== 'deed') {
      out.push({ id: `qa-${q.billQuestionId}`, at: new Date(q.answeredAt), who: face(q.answeredByName), body: <Figures text={q.answer} /> });
    }
  }

  for (const c of draft.comments) {
    out.push({ id: `c-${c.billCommentId}`, at: new Date(c.at), who: face(c.authorName), body: <Figures text={c.body} /> });
  }

  for (const m of chat?.messages ?? []) {
    if (m.role === 'user') {
      out.push({ id: `m-${m.messageId}`, at: new Date(m.createdAt), who: viewer, body: <Figures text={m.text} /> });
    } else {
      out.push({
        id: `m-${m.messageId}`,
        at: new Date(m.createdAt),
        who: 'decimal',
        live: m.status === 'running',
        body: m.status === 'running' ? <span className="bp-live">{m.thoughts[m.thoughts.length - 1]?.text ?? 'Looking into it'}</span>
          : m.status === 'failed' ? 'I couldn’t finish that. Ask again?'
          : <Markdown text={m.text} />,
        cards: m.status === 'done' ? m.actions : [],
      });
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** An action Decimal proposed in the chat. The person's click sends it. */
function ChatCard({ card, busy, onRun }: { card: CompanionActionCard; busy: boolean; onRun: () => void }) {
  return (
    <div className="bp-card bp-chatcard">
      <div className="bp-card-text"><b>{card.title}</b>{card.detail ? <> · <Figures text={card.detail} /></> : null}</div>
      {card.status === 'proposed' ? (
        <div className="bp-card-btns">
          <button type="button" className="bp-pill is-primary" disabled={busy} onClick={onRun}>{card.button}</button>
        </div>
      ) : card.result ? (
        <div className="bp-card-quiet">{card.result}</div>
      ) : card.status === 'done' ? (
        <div className="bp-card-quiet">Done</div>
      ) : null}
    </div>
  );
}

/** One message: a face, the name and time, the words, and anything under them. */
function Row({ said, onRunCard, busyCard, sentAt }: {
  said: Said;
  onRunCard: (card: CompanionActionCard) => void;
  busyCard: string | null;
  /** When a question a chat card sent was asked, once it is on the bill. */
  sentAt: (card: CompanionActionCard) => string | null;
}) {
  const name = said.who === 'decimal' ? 'Decimal agent' : said.who.name;
  const timed = !said.live && !said.waiting && !said.sending;
  return (
    <div className={`bp-row${said.forYou ? ' is-for-you' : ''}${said.sending ? ' is-sending' : ''}`}>
      <span className="bp-face">
        <FaceOf who={said.who} size={28} orb={said.live ? 'work' : 'rest'} bg="surf" />
        {said.waiting ? <WaitBadge /> : null}
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">{name}</span>
          {timed ? <span className="bp-who-time num">{chatTime(said.at)}</span> : null}
        </div>
        {said.body ? <div className={`bp-msg${said.waiting ? ' is-quiet' : ''}`}>{said.body}</div> : null}
        {said.sub ? <div className="bp-sub">{said.sub}</div> : null}
        {said.cards?.map((card) => (isAskCard(card)
          ? <AskCard key={card.actionId} card={card} busy={busyCard === card.actionId} sentAt={sentAt(card)} onRun={() => onRunCard(card)} />
          : <ChatCard key={card.actionId} card={card} busy={busyCard === card.actionId} onRun={() => onRunCard(card)} />))}
      </div>
    </div>
  );
}

function roleWord(c: AskCandidate) {
  const role = c.jobRole ?? c.role;
  return capitalise(role.replace(/_/g, ' '));
}

/**
 * The reply line: your face, the white pill field, and send. "@" brings a
 * colleague in, and the send circle turns into "Ask {name}"; without one the
 * message goes to Decimal. The ways to settle a single finding sit at its
 * right end, and drop below while you write.
 */
function ReplyLine({
  organizationId,
  billId,
  viewer,
  canAsk,
  placeholder,
  aboutFlag,
  actions,
  onAsked,
  onSay,
}: {
  organizationId: string;
  billId: string;
  viewer: Face;
  canAsk: boolean;
  placeholder: string;
  aboutFlag: string | null;
  actions: ReactNode;
  onAsked: () => Promise<void>;
  /** Anything without an @name: it may answer a question, or it is for Decimal. */
  onSay: (text: string) => Promise<void>;
}) {
  const toaster = useToaster();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<AskCandidate | null>(null);
  const [menuQuery, setMenuQuery] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useDismiss(menuQuery !== null, wrap, () => setMenuQuery(null));

  const candidates = useQuery({
    queryKey: ['ask-candidates', organizationId, billId, aboutFlag],
    queryFn: () => billsApi.askCandidates(organizationId, billId, aboutFlag),
    enabled: canAsk && menuQuery !== null,
    staleTime: 60_000,
  });
  const shown = (candidates.data?.candidates ?? []).filter((c) =>
    !menuQuery || c.name.toLowerCase().includes(menuQuery.toLowerCase()) || c.email.toLowerCase().includes(menuQuery.toLowerCase()));

  const onChange = (value: string) => {
    setText(value);
    if (mention && !value.includes(`@${mention.name}`)) setMention(null);
    const at = /(?:^|\s)@([^@\n]*)$/.exec(value);
    setMenuQuery(canAsk && at && !mention ? at[1]! : null);
  };

  const pick = (c: AskCandidate) => {
    setText((t) => `${t.replace(/(?:^|\s)@([^@\n]*)$/, (m) => `${m.startsWith(' ') ? ' ' : ''}@${c.name} `)}`);
    setMention(c);
    setMenuQuery(null);
    input.current?.focus();
  };

  const send = async () => {
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    try {
      if (mention) {
        const question = words.replace(`@${mention.name}`, '').replace(/\s{2,}/g, ' ').trim();
        if (question.length < 3) {
          toaster.show(`Write what you want to ask ${firstName(mention.name)}.`);
          return;
        }
        await billsApi.ask(organizationId, billId, { askedOfUserId: mention.userId, question, aboutFlag });
        setText('');
        setMention(null);
        await onAsked();
      } else {
        setText('');
        try {
          await onSay(words);
        } catch (e) {
          setText((t) => t || words);
          throw e;
        }
      }
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
    } finally {
      setSending(false);
    }
  };

  const writing = focused || text.length > 0;
  return (
    <div ref={wrap} className={`bp-reply${actions ? ' has-acts' : ''}${writing && actions ? ' is-writing' : ''}`}>
      <div className="bp-reply-me">
        <Avatar name={viewer.name} src={viewer.avatarUrl} size={28} />
        <div className="bp-reply-field">
          <input
            ref={input}
            value={text}
            placeholder={canAsk ? placeholder : 'Ask Decimal about this bill'}
            aria-label="Write a message"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && menuQuery !== null) {
                e.preventDefault();
                setMenuQuery(null);
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (menuQuery !== null && shown[0]) pick(shown[0]);
                else void send();
              }
            }}
          />
          {mention ? (
            <button type="button" className="bp-ask" disabled={sending} onMouseDown={(e) => e.preventDefault()} onClick={() => void send()}>
              Ask {firstName(mention.name)}
            </button>
          ) : (
            <button type="button" className="bp-send" aria-label="Send" disabled={!text.trim() || sending} onMouseDown={(e) => e.preventDefault()} onClick={() => void send()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {actions ? <div className="bp-reply-acts">{actions}</div> : null}
      {menuQuery !== null ? (
        <div className="menu bp-mention" role="listbox">
          <div className="bp-mention-head">Bring someone in</div>
          {candidates.isLoading ? <div className="bp-mention-head">Loading…</div> : null}
          {candidates.isSuccess && shown.length === 0 ? <div className="bp-mention-head">No one matches</div> : null}
          {shown.map((c) => (
            <button
              key={c.userId}
              type="button"
              role="option"
              aria-selected={false}
              className="menu-item bp-mention-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
            >
              <Avatar name={c.name} size={20} />
              <span>{c.name}</span>
              <span className="bp-mention-role">{roleWord(c)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AgentBox({
  organizationId,
  detail,
  note,
  fields,
  lines,
  viewer,
  access,
  editable,
  card,
  setCard,
  onFixTotal,
  onSaveNow,
  onChanged,
  lead = null,
  above = null,
}: {
  organizationId: string;
  detail: BillDetail;
  note: BillCompanionNote | null | undefined;
  fields: Fields;
  lines: LineEntry[];
  viewer: Face;
  access: Access;
  /** The viewer may settle findings here: the bill is in review and preparing it is their job. */
  editable: boolean;
  card: OpenCard | null;
  setCard: (card: OpenCard | null) => void;
  /** "Correct the figures": the total becomes what the lines and tax add up to. */
  onFixTotal: (total: number) => Promise<void>;
  /** Save the page as it stands, before a decision that reads the saved figures. */
  onSaveNow: () => Promise<void>;
  /** Something on the bill changed: read it again. */
  onChanged: () => Promise<void>;
  /**
   * What Decimal says in place of its findings: while it reads the bill
   * (5r), when it couldn't read the document (5u), and once the bill is past
   * review (5d to 5h), with the points that bear it out and when it said so.
   */
  lead?: {
    text: string;
    working: boolean;
    points?: Array<{ tone: 'ok' | 'bad'; text: string }>;
    at?: string | null;
    /** What can be done about it, under the message. */
    actions?: ReactNode;
  } | null;
  /** Above the box, in the same block: the route a bill took back to review (5e). */
  above?: ReactNode;
}) {
  const draft = detail.draft;
  const billId = draft.paymentOrderId;
  const toaster = useToaster();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [folded, setFolded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [cardsFolded, setCardsFolded] = useState<Record<string, boolean>>({});
  // A card opened from the bar (Close this bill) needs the box open to be seen.
  useEffect(() => {
    if (card) setFolded(false);
  }, [card]);
  const [chatId, setChatId] = useState<string | null>(note?.chatId ?? null);
  useEffect(() => {
    if (note?.chatId) setChatId((id) => id ?? note.chatId);
  }, [note?.chatId]);

  const chat = useQuery({
    queryKey: ['companion-chat', organizationId, chatId],
    queryFn: () => companionApi.chat(organizationId, chatId!),
    enabled: Boolean(chatId),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });

  const allFindings = useMemo(() => findingsOf(draft), [draft]);
  const findings = lead ? [] : allFindings;
  const notes = notesOf(draft);
  const faces = useMemo(() => {
    const map = new Map<string, string | null>();
    if (detail.requester) map.set(detail.requester.name, detail.requester.avatarUrl);
    for (const s of detail.approval?.steps ?? []) if (s.person) map.set(s.person.name, s.person.avatarUrl);
    for (const by of Object.values(draft.confirmedBy ?? {})) map.set(by.name, by.avatarUrl);
    map.set(viewer.name, viewer.avatarUrl);
    return map;
  }, [detail, draft.confirmedBy, viewer]);
  // The viewer's message while Decimal judges whether it answers anything.
  const [saying, setSaying] = useState<{ text: string; at: Date } | null>(null);
  const thread = useMemo(() => {
    const said = threadOf(detail, chat.data, viewer, faces, lines);
    if (saying) said.push({ id: 'saying', at: saying.at, who: viewer, body: <Figures text={saying.text} />, sending: true });
    // Whoever a question still waits on ends the thread, once each. The person
    // asked has the question on the band instead.
    const seen = new Set<string>();
    for (const q of detail.draft.questions) {
      if (!q.stillOpen || q.youWereAsked || seen.has(q.askedOfUserId)) continue;
      seen.add(q.askedOfUserId);
      said.push({
        id: `wait-${q.askedOfUserId}`, at: new Date(), waiting: true,
        who: { name: q.askedOfName, avatarUrl: faces.get(q.askedOfName) ?? null },
        body: 'Hasn’t answered yet',
      });
    }
    return said;
  }, [detail, chat.data, viewer, faces, lines, saying]);

  const tax = parseMoney(fields.taxAmount?.value) ?? 0;
  const printed = parseMoney(fields.total?.value) ?? draft.totalUsd;
  const itemisedTotal = Math.round((linesSum(lines) + tax) * 100) / 100;

  // When Decimal said it: when it raised what it found, or when it read the bill.
  const raisedAt = draft.workLog.find((e) => e.kind === 'flag_raised')?.at;
  const arrivedAt = [...detail.history.before].find((h) => (h.kind === 'uploaded' || h.kind === 'forwarded') && h.at)?.at;
  const saidAt = lead?.at ?? (findings.length > 0 ? raisedAt : null) ?? arrivedAt ?? raisedAt ?? null;

  const refresh = async () => {
    await Promise.all([
      onChanged(),
      queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['bill-note', organizationId, billId] }),
    ]);
  };

  const flagOf = (kind: string): Flag | null => draft.flags.find((f) => f.kind === kind) ?? null;

  const pick = async (flag: Flag, pill: Pill) => {
    if (busy) return;
    if (pill.action === 'not_ours') {
      const recommended = flag.finding?.recommended?.action === 'not_ours' ? flag.finding.recommended.reason
        : flag.brief?.status === 'ready' && flag.brief.recommendedAction === 'not_ours' ? flag.brief.reason
        : null;
      setCard({ kind: 'close', reason: closeReasonFor(flag.kind), note: recommended ?? '' });
      return;
    }
    if (pill.action === 'raise_ceiling') {
      navigate(`/organizations/${organizationId}/policies`);
      return;
    }
    if (pill.action === 'release_vendor') {
      navigate(`/organizations/${organizationId}/counterparties`);
      return;
    }
    if (pill.action === 'different_vendor') {
      if (!pill.targetId) return;
      setBusy(true);
      try {
        await billsApi.resolveSimilarVendor(organizationId, billId, pill.targetId, false);
        toaster.show('Kept as two companies. You won’t be asked about this pair again.');
        await refresh();
      } catch (e) {
        toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
      } finally {
        setBusy(false);
      }
      return;
    }
    const open = card?.kind === 'finding' && card.flagKind === flag.kind && card.action === pill.action;
    setCard(open ? null : { kind: 'finding', flagKind: flag.kind, action: pill.action, targetId: pill.targetId });
  };

  const confirm = async (result: CardResult) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      if (card.kind === 'close') {
        await billsApi.notABill(organizationId, billId, { reason: result.closeReason ?? card.reason, note: result.note || null });
        toaster.show('Closed. It won’t be approved or posted.');
      } else if (card.action === 'fix_fields') {
        await onFixTotal(itemisedTotal);
      } else if (card.action === 'pay_the_lines') {
        await onSaveNow();
        await billsApi.payItemised(organizationId, billId, result.reason ?? '');
      } else if (card.action === 'clear_duplicate') {
        await billsApi.overrideDuplicate(organizationId, billId, result.reason ?? '');
      } else if (card.action === 'allow_over_ceiling') {
        await billsApi.allowOverCeiling(organizationId, billId, result.reason ?? '');
      } else if (card.action === 'this_is_us') {
        await billsApi.thisIsUs(organizationId, billId, { name: result.name ?? '' });
        toaster.show('Recorded. Bills addressed to that name won’t be flagged again.');
      } else if (card.action === 'same_vendor') {
        if (!card.targetId) throw new Error('That vendor is no longer on file.');
        await billsApi.resolveSimilarVendor(organizationId, billId, card.targetId, true);
        toaster.show('Moved onto the vendor you already pay. The next bill under that name will match.');
      }
      setCard(null);
      await refresh();
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const talk = async (text: string) => {
    if (chatId) await companionApi.followUp(organizationId, chatId, text);
    else {
      const started = await companionApi.startChat(organizationId, text, billId);
      setChatId(started.chatId);
    }
    await queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId] });
  };

  // Said without an @name. With a question open it may be the answer, whoever
  // says it: Decimal judges, and the server keeps it in the shared thread when
  // it settles a question or comes from the person asked. Otherwise it was
  // said to Decimal.
  const say = async (text: string) => {
    setSaying({ text, at: new Date() });
    try {
      if (draft.questions.some((q) => q.stillOpen && (q.canAnswer || q.youAsked))) {
        const res = await billsApi.message(organizationId, billId, text);
        if (res.posted) {
          await refresh();
          return;
        }
      }
      await talk(text);
    } finally {
      setSaying(null);
    }
  };

  const runChatCard = async (action: CompanionActionCard) => {
    if (!chatId) return;
    if (action.open) {
      try {
        window.sessionStorage.setItem('decimal.goThere', JSON.stringify({ billId: action.billId, reason: action.reason, at: Date.now() }));
      } catch { /* the page just won't say why */ }
      await companionApi.recordOutcome(organizationId, chatId, action.actionId, { ok: true }).catch(() => null);
      void queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId, chatId] });
      navigate(`/organizations/${organizationId}${action.open.path}${action.open.focus ? `?focus=${encodeURIComponent(action.open.focus)}` : ''}`);
      return;
    }
    setBusyCard(action.actionId);
    try {
      await companionApi.runAction(organizationId, action);
      await companionApi.recordOutcome(organizationId, chatId, action.actionId, { ok: true });
    } catch (e) {
      await companionApi.recordOutcome(organizationId, chatId, action.actionId, {
        ok: false,
        message: e instanceof Error ? e.message : 'That didn’t go through.',
      }).catch(() => null);
    } finally {
      setBusyCard(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId, chatId] }),
        refresh(),
      ]);
    }
  };

  // A question sent from a chat card is on the bill now: when it was asked.
  const sentAt = (c: CompanionActionCard) => {
    const words = /^"([\s\S]*)"(?:\s·\s[^"]*)?$/.exec(c.detail)?.[1]?.trim();
    const to = /^Ask\s+(.*?):\s/.exec(c.title)?.[1];
    const q = draft.questions.find((x) => x.question.trim() === words && x.askedOfName === to);
    return q?.askedAt ?? null;
  };

  // What Decimal says, and the ways to settle it.
  const settleable = editable && draft.state === 'draft';
  const single = findings.length === 1 ? findings[0]! : null;
  const singlePills = single && settleable ? pillsFor(single, access) : [];
  const openKey = card?.kind === 'finding' ? `${card.flagKind}:${card.action}:${card.targetId ?? ''}` : null;
  const blocking = findings.filter((f) => f.blocking).length;

  let message: ReactNode;
  let foldedLine: ReactNode;
  if (lead) {
    message = (
      <>
        <div className="bp-msg"><Figures text={lead.text} /></div>
        {lead.points && lead.points.length > 0 ? (
          <div className="bp-points">
            {lead.points.map((p, i) => (
              <div key={i} className="bp-point">
                <Mark tone={p.tone} />
                <span className="bp-point-text"><Figures text={p.text} /></span>
              </div>
            ))}
          </div>
        ) : null}
        {lead.actions ? <div className="bp-acts is-lead">{lead.actions}</div> : null}
      </>
    );
    foldedLine = <Figures text={lead.text} />;
  } else if (findings.length === 0) {
    const resting = draft.state === 'draft' ? restingMessage(draft, fields, lines) : 'Nothing to flag.';
    message = <div className="bp-msg"><Figures text={resting} /></div>;
    foldedLine = <Figures text={resting} />;
  } else if (single) {
    message = <FindingText flag={single} organizationId={organizationId} />;
    foldedLine = <><b>{single.short}</b> · <FindingText flag={single} organizationId={organizationId} folded /></>;
  } else {
    const n = findings.length;
    const lead = blocking === 0 ? `${n} things on this bill are worth a look. None of them blocks it.`
      : blocking === n ? `${n} things on this bill, and ${n === 2 ? 'both' : 'all'} of them block it. Here they are in the order to settle them.`
      : `${n} things on this bill, and ${blocking} of them ${blocking === 1 ? 'blocks' : 'block'} it. Here they are in the order to settle them.`;
    message = (
      <>
        <div className="bp-msg">{lead}</div>
        <div className="bp-cards">
          {findings.map((f, i) => {
            const isFolded = cardsFolded[f.kind] ?? false;
            const pills = settleable ? pillsFor(f, access) : [];
            const cardHere = card?.kind === 'finding' && card.flagKind === f.kind;
            return (
              <div key={f.kind} className={`bp-fcard${isFolded ? ' is-folded' : ''}`}>
                <button
                  type="button"
                  className="bp-fcard-top"
                  aria-expanded={!isFolded}
                  onClick={() => setCardsFolded((s) => ({ ...s, [f.kind]: !isFolded }))}
                >
                  <span className="bp-fcard-n">{i + 1}</span>
                  <span className="bp-fcard-title">
                    <b>{f.short}</b>
                    {isFolded ? <span className="bp-fcard-line">{f.finding?.headline ?? f.message}</span> : null}
                  </span>
                  <span className={`bp-fcard-sev ${f.blocking ? 'is-blocks' : f.severity === 'warning' ? 'is-warning' : 'is-note'}`}>
                    {f.blocking ? 'Blocks' : f.severity === 'warning' ? 'Warning' : 'Note'}
                    <Chevron />
                  </span>
                </button>
                {isFolded ? null : (
                  <div className="bp-fcard-body">
                    <FindingText flag={f} organizationId={organizationId} />
                    {pills.length > 0 ? (
                      <div className="bp-acts">
                        <ActionPills pills={pills} open={openKey} small onPick={(p) => void pick(f, p)} />
                        {pills.filter((p) => !p.allowed).slice(0, 1).map((p) => <span key={p.key} className="bp-act-note">{p.why}</span>)}
                      </div>
                    ) : null}
                    {cardHere ? (
                      <ConfirmCard card={card} flag={f} draft={draft} totals={{ printed, lines: itemisedTotal }} busy={busy} onConfirm={(r) => void confirm(r)} onCancel={() => setCard(null)} />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
    foldedLine = <Figures text={lead} />;
  }

  const singleActions = singlePills.length > 0 ? (
    <ActionPills pills={singlePills} open={openKey} onPick={(p) => void pick(single!, p)} />
  ) : null;
  // A card from the single finding, or the close card, sits under the thread.
  const bottomCard = card && (card.kind === 'close' || findings.length <= 1) ? card : null;
  const canAsk = draft.canJoinConversation;
  const forMe = draft.questions.find((q) => q.stillOpen && q.youWereAsked);

  return (
    <div className="bp-agentwrap">
      {above ? <div className="bp-above">{above}</div> : null}
      <div className="bp-agent">
        <button
          type="button"
          className={`bp-fold${folded ? ' is-folded' : ''}`}
          aria-expanded={!folded}
          aria-label={folded ? 'Open the conversation' : 'Fold the conversation'}
          onClick={() => setFolded((v) => !v)}
        >
          <Chevron />
        </button>
        <div className="bp-row">
          <span className="bp-face"><FaceOf who="decimal" size={28} orb={chat.data?.running || lead?.working ? 'work' : 'rest'} bg="surf" /></span>
          <div className="bp-said">
            <div className="bp-who">
              <span className="bp-who-name">Decimal agent</span>
              {saidAt ? <span className="bp-who-time num">{chatTime(saidAt)}</span> : null}
            </div>
            {folded ? <div className="bp-msg is-folded">{foldedLine}</div> : (
              <>
                {message}
                {notes.length > 0 && findings.length > 0 ? <div className="bp-reason">{notes.join(' ')}</div> : null}
              </>
            )}
          </div>
        </div>
        {folded ? null : (
          <>
            {thread.length > 0 ? (
              <div className="bp-thread">
                {thread.map((said) => (
                  <Row key={said.id} said={said} busyCard={busyCard} onRunCard={(c) => void runChatCard(c)} sentAt={sentAt} />
                ))}
              </div>
            ) : null}
            {bottomCard ? (
              <>
                <ConfirmCard
                  card={bottomCard}
                  flag={bottomCard.kind === 'finding' ? flagOf(bottomCard.flagKind) : null}
                  draft={draft}
                  totals={{ printed, lines: itemisedTotal }}
                  busy={busy}
                  onConfirm={(r) => void confirm(r)}
                  onCancel={() => setCard(null)}
                />
                {bottomCard.kind === 'finding' && singleActions ? <div className="bp-acts">{singleActions}</div> : null}
              </>
            ) : (
              <ReplyLine
                organizationId={organizationId}
                billId={billId}
                viewer={viewer}
                canAsk={canAsk}
                placeholder={forMe ? `Answer ${firstName(forMe.askedByName)}…` : thread.length > 0 ? 'Reply… type @ to bring someone in' : 'Ask here… @ brings someone in'}
                aboutFlag={single?.kind ?? findings[0]?.kind ?? null}
                actions={singleActions}
                onAsked={refresh}
                onSay={say}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

