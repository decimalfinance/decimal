// Home (Home.dc.html 4a): the page you land on. On the left, what is waiting
// on you, summed up from the Inbox, and the bills that need you now. On the
// right, Decimal's box: ask it about any bill, vendor or approval and it
// answers in the box, which can grow to full screen. Nothing on Home acts:
// every card opens its bill, and approving or sending back happen there.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  accessApi,
  api,
  billsApi,
  companionApi,
  inboxApi,
  type CompanionActionCard,
  type CompanionChat,
  type InboxItem,
  type InboxLine,
  type PendingDocument,
  type WorkbenchBill,
} from '../api';
import { Avatar } from '../kit/Avatar';
import { Orb } from '../kit/Orb';
import { useToaster } from '../kit/Toast';
import { zoomOf } from '../kit/zoom';
import { daysPast, firstName, shortDay, usd } from '../kit/format';
import { AskCard, isAskCard } from './bill/AskCard';
import type { Face } from './bill/model';
import { FaceOf, Figures, Markdown, chatTime } from './bill/parts';
import { classify } from './billStatus';
import { ASK_KINDS, LINE_ORDER, pathOf } from './inboxLines';

/** A bill that needs you now: its most pressing line, and how late it is (days; below 0 is still to come). */
type Attention = { key: string; item: InboxItem; line: InboxLine; late: number; to: string };
type Tally = { total: number; overdue: number; approvals: number; questions: number; review: number; fresh: number };
type Message = CompanionChat['messages'][number];
type Me = { userId: string; face: Face; first: string | null };
type Rect = { top: number; left: number; width: number; height: number };
type Screen = { full: boolean; closing: boolean; style: CSSProperties; open: () => void; close: () => void };

const CARDS = 6;
/** The page's margin around the box when it is full screen. */
const FULL_GAP = 30;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const rank = (line: InboxLine) => LINE_ORDER.indexOf(line.kind);

/** The Inbox, counted as the tile and the sidebar count it: one for each line. */
function tallyOf(items: InboxItem[], now: Date): Tally {
  const t: Tally = { total: 0, overdue: 0, approvals: 0, questions: 0, review: 0, fresh: 0 };
  for (const item of items) {
    const late = item.dueAt ? daysPast(item.dueAt, now) > 0 : false;
    for (const line of item.lines) {
      t.total += 1;
      if (late) t.overdue += 1;
      if (line.isNew) t.fresh += 1;
      if (line.kind === 'approval') t.approvals += 1;
      else if (ASK_KINDS.includes(line.kind)) t.questions += 1;
      else t.review += 1;
    }
  }
  return t;
}

/**
 * The bills in the Inbox that are overdue or due by Sunday, each with its most
 * pressing line: the most overdue first, then the soonest due.
 */
function attentionOf(items: InboxItem[], organizationId: string, now: Date): Attention[] {
  const toSunday = (7 - now.getDay()) % 7;
  const out: Attention[] = [];
  for (const item of items) {
    if (!item.billId || !item.dueAt) continue;
    const late = daysPast(item.dueAt, now);
    if (late < -toSunday) continue;
    const line = [...item.lines].sort((a, b) => rank(a) - rank(b))[0];
    if (line) out.push({ key: item.key, item, line, late, to: pathOf(item, organizationId) });
  }
  return out.sort((a, b) => b.late - a.late || rank(a.line) - rank(b.line));
}

/** The one Decimal leads with: overdue before due, then your own move first (approvals, then questions). */
function mostPressing(attention: Attention[]): Attention | null {
  return [...attention].sort((a, b) =>
    Number(b.late > 0) - Number(a.late > 0) || rank(a.line) - rank(b.line) || b.late - a.late)[0] ?? null;
}

/** The card's colour: who wants it, or Decimal's own pink for what Decimal raised. */
function toneOf(line: InboxLine) {
  if (line.kind === 'approval' || line.kind === 'question' || line.kind === 'reply') return line.kind;
  return line.kind === 'sent_back' ? 'sentback' : 'decimal';
}

/** The Inbox's line, shortened for a card: first names, nobody's quoted words. */
function reasonOf(line: InboxLine): string {
  const name = line.who?.name ?? null;
  const first = name ? firstName(name) : 'Someone';
  switch (line.kind) {
    case 'approval': return name ? line.lead.replace(name, first) : line.lead;
    case 'question': return `${first} asked you a question`;
    case 'reply': return `${first} ${line.lead.includes('couldn’t answer') ? 'couldn’t answer' : 'answered'} your question`;
    case 'sent_back': return name ? `${first} sent it back` : line.lead;
    case 'sync_failed': return 'QuickBooks refused it';
    default: return line.lead;
  }
}

function dueWords(dueAt: string, late: number): string {
  if (late > 0) return `${late} ${late === 1 ? 'day' : 'days'} overdue`;
  if (late === 0) return 'Due today';
  if (late === -1) return 'Due tomorrow';
  return `Due ${WEEKDAYS[new Date(dueAt).getUTCDay()]} ${shortDay(dueAt)}`;
}

function greetingOf(first: string | null, now = new Date()): string {
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return first ? `${part}, ${first}` : part;
}

/** Three questions to start with; the middle one names the bill Decimal leads with, when it is late. */
function suggestionsOf(pressing: Attention | null, attention: Attention[]): string[] {
  const late = [pressing, ...attention].find((a) => a && a.late > 0 && a.item.invoiceNumber);
  return [
    'How much is due this week?',
    late ? `Why is ${late.item.invoiceNumber} overdue?` : 'What came in this week?',
    'Which vendors are new this month?',
  ];
}

function recall(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    /* the conversation just won't come back after a reload */
  }
}

function glyph(size: number, width: number, d: string) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d={d} />
    </svg>
  );
}
const EXPAND = 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7';
const COLLAPSE = 'M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7';
const PLUS = 'M12 5v14M5 12h14';
const SEND = 'M12 19V5M6 11l6-6 6 6';
const ARROW = 'M5 12h14M13 6l6 6-6 6';

/**
 * Full screen: the box grows from its place to 30px inside the page's edges,
 * the same element all the way, and stays over the scrim while it shrinks
 * back. Esc, the scrim and the collapse icon leave it.
 */
function useFullScreen(page: RefObject<HTMLDivElement | null>, wrap: RefObject<HTMLDivElement | null>): Screen {
  const [full, setFull] = useState(false);
  const [closing, setClosing] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const measure = useCallback((): Rect | null => {
    const root = page.current;
    const place = wrap.current;
    if (!root || !place) return null;
    const r = root.getBoundingClientRect();
    const p = place.getBoundingClientRect();
    const z = zoomOf(root);
    return {
      top: (r.top - p.top) / z + FULL_GAP,
      left: (r.left - p.left) / z + FULL_GAP,
      width: root.clientWidth - 2 * FULL_GAP,
      height: root.clientHeight - 2 * FULL_GAP,
    };
  }, [page, wrap]);
  const open = useCallback(() => {
    const m = measure();
    if (!m) return;
    window.clearTimeout(timer.current);
    setClosing(false);
    setRect(m);
    setFull(true);
  }, [measure]);
  const close = useCallback(() => {
    setFull(false);
    setClosing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setClosing(false), 600);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // While open it keeps to the page: the window resized, the sidebar folded.
  useEffect(() => {
    const root = page.current;
    if (!full || !root) return;
    const watch = new ResizeObserver(() => {
      const m = measure();
      if (m) setRect(m);
    });
    watch.observe(root);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      watch.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, [full, page, measure, close]);
  const style: CSSProperties = full && rect
    ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    : { top: 0, left: 0, width: '100%', height: '100%' };
  return { full, closing, style, open, close };
}

export function HomePage() {
  const { organizationId = '' } = useParams();
  const page = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const screen = useFullScreen(page, wrap);

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const inbox = useQuery({
    queryKey: ['inbox', organizationId],
    queryFn: () => inboxApi.get(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });
  // Bills' own query: what Decimal is reading now, and how each bill an
  // answer points at stands.
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: (q) => (q.state.data?.pending.some((d) => d.status === 'processing') ? 2_000 : 30_000),
  });
  // A file read is a bill to review: count it now, not at the Inbox's next poll.
  const queryClient = useQueryClient();
  const readingNow = (workbench.data?.pending ?? []).filter((d) => d.status === 'processing').length;
  const readingBefore = useRef(readingNow);
  useEffect(() => {
    if (readingNow < readingBefore.current) void queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] });
    readingBefore.current = readingNow;
  }, [readingNow, organizationId, queryClient]);

  const user = session.data?.user;
  const me: Me | null = user
    ? {
      userId: user.userId,
      face: { name: user.displayName ?? user.email ?? 'You', avatarUrl: user.avatarUrl ?? null },
      first: user.displayName ? firstName(user.displayName) : null,
    }
    : null;
  const capabilities = access.data?.capabilities;
  const canAdd = capabilities ? capabilities.includes('bills.create') : false;
  const canReview = capabilities ? capabilities.includes('bills.edit') : false;

  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const now = useMemo(() => new Date(), [inbox.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const tally = useMemo(() => (inbox.data ? tallyOf(items, now) : null), [inbox.data, items, now]);
  const attention = useMemo(() => attentionOf(items, organizationId, now), [items, organizationId, now]);
  const pressing = useMemo(() => mostPressing(attention), [attention]);
  const suggestions = useMemo(() => suggestionsOf(pressing, attention), [pressing, attention]);
  const reading = canAdd ? (workbench.data?.pending ?? []).filter((d) => d.status === 'processing') : [];
  const billIndex = useMemo(
    () => new Map((workbench.data?.bills ?? []).map((b) => [b.paymentOrderId, b])),
    [workbench.data],
  );

  return (
    <div className="ui home-page" ref={page}>
      <div className={`hm-scrim${screen.full ? ' is-on' : ''}`} aria-hidden onClick={screen.close} />
      <div className={`hm-scroll${screen.full ? ' is-locked' : ''}`}>
        <div className="hm-grid">
          <div className="hm-left">
            <h1 className="list-title">Home</h1>
            <div className="hm-blocks">
              <WaitingOnYou organizationId={organizationId} tally={tally} failed={inbox.isError && !inbox.data} onRetry={() => void inbox.refetch()} />
              <NeedsAttention cards={attention.slice(0, CARDS)} ready={Boolean(inbox.data)} />
            </div>
          </div>
          <div className="hm-boxwrap" ref={wrap}>
            {me ? (
              <DecimalBox
                organizationId={organizationId}
                me={me}
                canReview={canReview}
                screen={screen}
                opening={inbox.data ? <Opening items={items} pressing={pressing} organizationId={organizationId} /> : null}
                suggestions={suggestions}
                reading={reading}
                billIndex={billIndex}
              />
            ) : (
              <div className="hm-box" style={screen.style} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WaitingOnYou({ organizationId, tally, failed, onRetry }: { organizationId: string; tally: Tally | null; failed: boolean; onRetry: () => void }) {
  const inbox = `/organizations/${organizationId}/inbox`;
  const rows = tally
    ? [
      { key: 'approvals', label: 'Approvals', n: tally.approvals },
      { key: 'questions', label: 'Questions', n: tally.questions },
      { key: 'review', label: 'To review', n: tally.review },
    ]
    : [];
  return (
    <section className="hm-block">
      <div className="hm-h">
        <h2>Waiting on you</h2>
      </div>
      <div className="hm-tile">
        {tally ? (
          <>
            <div className="hm-tile-top">
              <span className="hm-tile-n">{tally.total}</span>
              <span className="hm-tile-label">in your Inbox</span>
              {tally.overdue > 0 ? (
                <span className="hm-tile-late">
                  <span className="num">{tally.overdue}</span> overdue
                </span>
              ) : null}
            </div>
            <div className="hm-tile-rows">
              {rows.map((r) => (
                <Link key={r.key} to={`${inbox}?tab=${r.key}`} className="hm-tile-row" title={`Opens your Inbox on ${r.label}`}>
                  <span className={`hm-swatch k-${r.key}`} aria-hidden />
                  <span className="hm-tile-row-label">{r.label}</span>
                  <span className="hm-tile-row-n">{r.n}</span>
                </Link>
              ))}
            </div>
            <div className="hm-tile-new">
              {tally.fresh > 0 ? (
                <>
                  <span className="num">{tally.fresh}</span> new since you last looked
                </>
              ) : (
                'Nothing new since you last looked'
              )}
            </div>
          </>
        ) : failed ? (
          <div className="hm-quiet">
            Your Inbox couldn’t be loaded.{' '}
            <button type="button" className="hm-retry" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
        <div className="hm-tile-foot">
          <Link to={inbox} className="hm-open">
            Open Inbox {glyph(10, 2.4, ARROW)}
          </Link>
        </div>
      </div>
    </section>
  );
}

function NeedsAttention({ cards, ready }: { cards: Attention[]; ready: boolean }) {
  return (
    <section className="hm-block">
      <div className="hm-h">
        <h2>Needs attention</h2>
        {ready ? <span className="hm-h-n">{cards.length}</span> : null}
        <span className="hm-h-note">Overdue, or due this week</span>
      </div>
      {!ready ? null : cards.length === 0 ? (
        <div className="hm-quiet">Nothing is overdue or due this week.</div>
      ) : (
        <div className="hm-cards">
          {cards.map((a) => (
            <AttentionCard key={a.key} a={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function AttentionCard({ a }: { a: Attention }) {
  const { item, line, late } = a;
  return (
    <Link to={a.to} className={`hm-card k-${toneOf(line)}`} title={item.invoiceNumber ? `Opens ${item.invoiceNumber}` : `Opens the ${item.vendorName} bill`}>
      <div className="hm-card-why">
        <span className="hm-face">
          {line.who ? <Avatar name={line.who.name} src={line.who.avatarUrl} size={16} /> : <Orb size={16} state="rest" bg="surf" title="Decimal agent" />}
        </span>
        <span className="hm-card-why-text">{reasonOf(line)}</span>
      </div>
      <div className="hm-card-vendor">{item.vendorName}</div>
      <div className="hm-card-foot">
        <span className={`hm-card-due${late > 0 ? ' is-late' : ''}`}>
          <Figures text={dueWords(item.dueAt!, late)} />
        </span>
        {item.amountUsd == null ? <span className="hm-card-amt is-none">No amount</span> : <span className="hm-card-amt">{usd(item.amountUsd)}</span>}
      </div>
    </Link>
  );
}

/** Decimal's line under the greeting, written by code from the Inbox: how many, then the one to start with. */
function Opening({ items, pressing, organizationId }: { items: InboxItem[]; pressing: Attention | null; organizationId: string }) {
  const inbox = `/organizations/${organizationId}/inbox`;
  const bills = items.filter((i) => i.billId).length;
  const files = items.length - bills;
  const head = bills > 0 ? (
    <>
      <Link to={inbox}>{bills === 1 ? 'One bill' : <><span className="num">{bills}</span> bills</>}</Link> {bills === 1 ? 'is' : 'are'} waiting on you.
    </>
  ) : files > 0 ? (
    <>
      <Link to={inbox}>{files === 1 ? 'A file' : <><span className="num">{files}</span> files</>}</Link> couldn’t be read.
    </>
  ) : (
    'Nothing is waiting on you.'
  );
  return (
    <p className="hm-line">
      {head}
      {pressing ? <> <Pressing a={pressing} /></> : null}
    </p>
  );
}

function Pressing({ a }: { a: Attention }) {
  const { item, line, late } = a;
  const ref = (start: boolean) => item.invoiceNumber
    ? <Link to={a.to} className="num">{item.invoiceNumber}</Link>
    : <>{start ? 'The' : 'the'} <Link to={a.to}>{item.vendorName}</Link> bill</>;
  const when = late > 0 ? <><span className="num">{late}</span> {late === 1 ? 'day' : 'days'} overdue</>
    : late === 0 ? 'due today'
    : late === -1 ? 'due tomorrow'
    : <>due on {WEEKDAYS[new Date(item.dueAt!).getUTCDay()]} <span className="num">{shortDay(item.dueAt!)}</span></>;
  const who = line.who ? firstName(line.who.name) : 'Someone';
  switch (line.kind) {
    case 'approval':
      return <>Your approval on {ref(false)} is {when}.</>;
    case 'question':
      return <>{who} asked you about {ref(false)}, which is {when}.</>;
    case 'reply':
      return <>{who} {line.lead.includes('couldn’t answer') ? 'couldn’t answer' : 'answered'} your question on {ref(false)}, which is {when}.</>;
    case 'sent_back':
      return <>{ref(true)} was sent back to review and is {when}.</>;
    default:
      return item.invoiceNumber ? <>{ref(true)} from {item.vendorName} is {when}.</> : <>{ref(true)} is {when}.</>;
  }
}

/** A chip with a +: it puts its question in the field, and never sends it. */
function Chip({ text, small, onPick }: { text: string; small?: boolean; onPick: () => void }) {
  return (
    <button type="button" className="hm-chip" onClick={onPick}>
      {small ? glyph(10, 2.4, PLUS) : glyph(8, 3.2, PLUS)}
      <span className="hm-chip-text">
        <Figures text={text} />
      </span>
    </button>
  );
}

/** One message: a face, the name and time, the words, and anything under them. */
function ChatRow({ who, at, live, asked, children, after }: {
  who: Face | 'decimal';
  at: string;
  live?: boolean;
  /** The person's own question: where the list scrolls to. */
  asked?: boolean;
  children: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div className="bp-row" data-asked={asked ? '' : undefined}>
      <span className="bp-face">
        <FaceOf who={who} size={28} orb={live ? 'work' : 'rest'} bg="surf" />
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">{who === 'decimal' ? 'Decimal agent' : who.name}</span>
          <span className="bp-who-time num">{chatTime(at)}</span>
        </div>
        <div className="bp-msg">{children}</div>
        {after}
      </div>
    </div>
  );
}

/** The bills an answer rests on, once each, with the go-there card that opens it, if Decimal made one. */
function billCardsOf(m: Message): Array<{ billId: string; action: CompanionActionCard | null }> {
  const goThere = m.actions.filter((a) => !isAskCard(a) && a.open);
  const ids = [...new Set([...m.billIds, ...goThere.map((a) => a.billId)])];
  return ids.map((billId) => ({ billId, action: goThere.find((a) => a.billId === billId) ?? null }));
}

/** A bill an answer points at, as Bills shows it: vendor, number, amount, when it is due, where it stands. */
function AnswerCard({ billId, action, bill, known, organizationId, viewer, onOpen }: {
  billId: string;
  action: CompanionActionCard | null;
  bill: WorkbenchBill | undefined;
  known: CompanionChat['bills'][string] | undefined;
  organizationId: string;
  viewer: { userId: string; canReview: boolean };
  onOpen: (action: CompanionActionCard) => void;
}) {
  const vendor = bill?.vendorName ?? known?.vendorName;
  if (!vendor) return null;
  const invoice = bill ? bill.invoiceNumber : known?.invoiceNumber ?? null;
  const amount = bill?.amountUsd ?? known?.amountUsd ?? null;
  const status = bill ? classify(bill, viewer) : null;
  const late = status && status.stage !== 'done' && bill?.dueAt ? daysPast(bill.dueAt) : 0;
  const due = !bill ? null
    : !bill.dueAt ? 'No due date'
    : `Due ${shortDay(bill.dueAt)}${late > 0 ? ` · ${late} ${late === 1 ? 'day' : 'days'} overdue` : ''}`;
  const to = action?.open
    ? `/organizations/${organizationId}${action.open.path}${action.open.focus ? `?focus=${encodeURIComponent(action.open.focus)}` : ''}`
    : `/organizations/${organizationId}/bills/${billId}`;
  return (
    <Link to={to} className="hm-bill" title={invoice ? `Opens ${invoice}` : `Opens the ${vendor} bill`} onClick={action ? () => onOpen(action) : undefined}>
      <div className="hm-bill-top">
        <span className="hm-bill-vendor">{vendor}</span>
        {invoice ? <span className="hm-bill-inv">{invoice}</span> : null}
        {amount != null ? <span className="hm-bill-amt">{usd(amount)}</span> : null}
      </div>
      {due || status ? (
        <div className="hm-bill-foot">
          <span className={`hm-bill-due${late > 0 ? ' is-late' : ''}`}>{due ? <Figures text={due} /> : null}</span>
          {status ? <span className={`chip is-${status.part.tone}`}>{status.chip}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}

function DecimalBox({ organizationId, me, canReview, screen, opening, suggestions, reading, billIndex }: {
  organizationId: string;
  me: Me;
  canReview: boolean;
  screen: Screen;
  opening: ReactNode;
  suggestions: string[];
  reading: PendingDocument[];
  billIndex: Map<string, WorkbenchBill>;
}) {
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The conversation stays while you go and look at a bill and come back,
  // until the tab closes or you start over.
  const storeKey = `decimal.homeChat.${organizationId}.${me.userId}`;
  const [chatId, setChatId] = useState<string | null>(() => recall(storeKey));
  const [text, setText] = useState('');
  const [sending, setSending] = useState<{ text: string; at: string } | null>(null);
  const [busyCard, setBusyCard] = useState<string | null>(null);

  const chat = useQuery({
    queryKey: ['companion-chat', organizationId, chatId],
    queryFn: () => companionApi.chat(organizationId, chatId!),
    enabled: Boolean(chatId),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const forget = useCallback(() => {
    keep(storeKey, null);
    setChatId(null);
  }, [storeKey]);
  // A conversation that is not there any more: back to the greeting.
  useEffect(() => {
    if (chat.error instanceof ApiError && chat.error.status === 404) forget();
  }, [chat.error, forget]);

  const messages = chat.data?.messages ?? [];
  const busy = sending !== null || Boolean(chat.data?.running);
  const talking = Boolean(chatId) || sending !== null;
  const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;

  const fill = (question: string) => {
    setText(question);
    input.current?.focus();
  };

  const send = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setText('');
    setSending({ text: question, at: new Date().toISOString() });
    try {
      let id = chatId;
      if (id) await companionApi.followUp(organizationId, id, question);
      else {
        id = (await companionApi.startChat(organizationId, question)).chatId;
        keep(storeKey, id);
      }
      const started = id;
      await queryClient.fetchQuery({
        queryKey: ['companion-chat', organizationId, started],
        queryFn: () => companionApi.chat(organizationId, started),
        staleTime: 0,
      });
      setChatId(started);
    } catch (e) {
      setText((t) => t || question);
      toaster.show(e instanceof Error ? e.message : 'That didn’t go through. Try again.');
    } finally {
      setSending(null);
    }
  };

  const startOver = () => {
    forget();
    setText('');
    screen.close();
  };

  // Opening a bill from Decimal's card is what the card was for.
  const opened = (action: CompanionActionCard) => {
    if (!chatId || action.status !== 'proposed') return;
    void companionApi.recordOutcome(organizationId, chatId, action.actionId, { ok: true })
      .then(() => queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId, chatId] }))
      .catch(() => null);
  };

  // A question Decimal drafted: Send question asks it on the bill.
  const runAsk = async (card: CompanionActionCard) => {
    if (!chatId) return;
    setBusyCard(card.actionId);
    try {
      await companionApi.runAction(organizationId, card);
      await companionApi.recordOutcome(organizationId, chatId, card.actionId, { ok: true });
    } catch (e) {
      await companionApi.recordOutcome(organizationId, chatId, card.actionId, {
        ok: false,
        message: e instanceof Error ? e.message : 'That didn’t go through.',
      }).catch(() => null);
    } finally {
      setBusyCard(null);
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId, chatId] });
    }
  };

  // Each new question goes to the top of the list, with what Decimal says under it.
  const tail = `${messages.length}:${messages[messages.length - 1]?.status ?? ''}:${sending ? 'sending' : ''}`;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const asked = el.querySelectorAll<HTMLElement>('[data-asked]');
    const last = asked[asked.length - 1];
    if (!last) return;
    const top = (last.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomOf(el) + el.scrollTop;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [tail]);

  const viewer = { userId: me.userId, canReview };
  const corner = (
    <button
      type="button"
      className="hm-icon"
      title={screen.full ? 'Back to Home' : 'Full screen'}
      aria-label={screen.full ? 'Back to Home' : 'Full screen'}
      onClick={screen.full ? screen.close : screen.open}
    >
      {glyph(12, 2.2, screen.full ? COLLAPSE : EXPAND)}
    </button>
  );

  const readingPill = reading.length === 0 ? null : (
    <Link
      className="hm-reading"
      to={reading.length === 1
        ? `/organizations/${organizationId}/bills/documents/${reading[0]!.invoiceDocumentId}/draft`
        : `/organizations/${organizationId}/bills`}
    >
      <span className="hm-reading-dot" aria-hidden />
      <span className="hm-reading-text">
        {reading.length === 1 ? `Extracting the details from ${reading[0]!.filename}…` : <>Extracting the details from <span className="num">{reading.length}</span> files…</>}
      </span>
    </Link>
  );

  return (
    <div className={`hm-box${screen.full ? ' is-full' : ''}${screen.closing ? ' is-closing' : ''}`} style={screen.style}>
      {talking ? (
        <div className="hm-conv">
          <div className="hm-conv-head">
            <span className="hm-label">DECIMAL AGENT</span>
            <span className="hm-conv-tools">
              {screen.full ? (
                <button type="button" className="hm-restart" onClick={startOver}>
                  Start over
                </button>
              ) : null}
              {corner}
            </span>
          </div>
          <div className="hm-list" ref={list}>
            {messages.map((m) => (m.role === 'user' ? (
              <ChatRow key={m.messageId} who={me.face} at={m.createdAt} asked>
                <Figures text={m.text} />
              </ChatRow>
            ) : m.status === 'running' ? (
              <ChatRow key={m.messageId} who="decimal" at={m.createdAt} live>
                <span className="bp-live">{m.thoughts[m.thoughts.length - 1]?.text ?? 'Looking through your bills'}</span>
              </ChatRow>
            ) : m.status === 'failed' ? (
              <ChatRow key={m.messageId} who="decimal" at={m.createdAt}>
                I couldn’t finish that. Ask again?
              </ChatRow>
            ) : (
              <ChatRow
                key={m.messageId}
                who="decimal"
                at={m.createdAt}
                after={
                  <Under
                    m={m}
                    last={m === lastAnswer && !sending}
                    organizationId={organizationId}
                    bills={chat.data?.bills ?? {}}
                    billIndex={billIndex}
                    viewer={viewer}
                    busyCard={busyCard}
                    onOpen={opened}
                    onAsk={(c) => void runAsk(c)}
                    onPick={fill}
                  />
                }
              >
                <Markdown text={m.text} />
              </ChatRow>
            )))}
            {sending ? (
              <>
                <ChatRow who={me.face} at={sending.at} asked>
                  <Figures text={sending.text} />
                </ChatRow>
                <ChatRow who="decimal" at={sending.at} live>
                  <span className="bp-live">Looking through your bills</span>
                </ChatRow>
              </>
            ) : null}
            {chat.isError && !chat.data && !sending ? (
              <div className="hm-quiet">
                This conversation couldn’t be loaded.{' '}
                <button type="button" className="hm-retry" onClick={() => void chat.refetch()}>
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <span className="hm-corner">{corner}</span>
          <div className="hm-hello">
            <span className="hm-space" />
            <span className="hm-orb">
              <Orb size={72} state={reading.length > 0 ? 'work' : 'rest'} bg="surf" title="Decimal agent" />
            </span>
            <div className="hm-label">DECIMAL AGENT</div>
            <h2 className="hm-greet">{greetingOf(me.first)}</h2>
            {opening}
            {readingPill}
            <span className="hm-space is-low" />
            <div className="hm-suggest">
              <div className="hm-suggest-label">Suggested</div>
              <div className="hm-chips">
                {suggestions.map((s) => (
                  <Chip key={s} text={s} onPick={() => fill(s)} />
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      <div className="hm-field">
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') setText('');
          }}
          placeholder={talking ? 'Ask a follow-up' : 'Ask about any bill, vendor or approval'}
          aria-label="Ask Decimal agent"
        />
        <button type="button" className={`hm-send${text.trim() && !busy ? ' is-ready' : ''}`} aria-label="Ask" onClick={() => void send()}>
          {glyph(12, 2.6, SEND)}
        </button>
      </div>
    </div>
  );
}

/** Under an answer: the bills it rests on, any question Decimal drafted, and what to ask next. */
function Under({ m, last, organizationId, bills, billIndex, viewer, busyCard, onOpen, onAsk, onPick }: {
  m: Message;
  last: boolean;
  organizationId: string;
  bills: CompanionChat['bills'];
  billIndex: Map<string, WorkbenchBill>;
  viewer: { userId: string; canReview: boolean };
  busyCard: string | null;
  onOpen: (action: CompanionActionCard) => void;
  onAsk: (card: CompanionActionCard) => void;
  onPick: (question: string) => void;
}) {
  const cards = billCardsOf(m).filter((c) => billIndex.has(c.billId) || bills[c.billId]);
  const asks = m.actions.filter(isAskCard);
  const next = last ? m.followUps : [];
  if (cards.length === 0 && asks.length === 0 && next.length === 0) return null;
  return (
    <>
      {cards.length > 0 ? (
        <div className="hm-bills">
          {cards.map((c) => (
            <AnswerCard
              key={c.billId}
              billId={c.billId}
              action={c.action}
              bill={billIndex.get(c.billId)}
              known={bills[c.billId]}
              organizationId={organizationId}
              viewer={viewer}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
      {asks.length > 0 ? (
        <div className="hm-asks">
          {asks.map((card) => (
            <AskCard key={card.actionId} card={card} busy={busyCard === card.actionId} sentAt={null} onRun={() => onAsk(card)} />
          ))}
        </div>
      ) : null}
      {next.length > 0 ? (
        <div className="hm-next">
          {next.map((q) => (
            <Chip key={q} text={q} small onPick={() => onPick(q)} />
          ))}
        </div>
      ) : null}
    </>
  );
}
