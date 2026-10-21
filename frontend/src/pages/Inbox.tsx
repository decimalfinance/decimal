// Inbox (Inbox.dc.html 22b): everything waiting on you, one row for each
// thing, in one table. Approvals first, then questions and the replies to
// yours, then the team's pile; the earliest due first within each. A row
// opens its bill: nothing is approved, answered or sent back from here, there
// is no Done and no agent. A line leaves by itself once it is dealt with.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { inboxApi, type InboxItem, type InboxLine, type InboxLineKind } from '../api';
import { Avatar } from '../kit/Avatar';
import { Cells } from '../kit/Cells';
import { Icon } from '../kit/icons';
import { Orb } from '../kit/Orb';
import { daysPast, shortDay, usd } from '../kit/format';
import { Figures } from './bill/parts';
import { ASK_KINDS, LINE_ORDER, pathOf } from './inboxLines';

type Tab = 'all' | 'new' | 'approvals' | 'questions' | 'review';
type Row = { key: string; item: InboxItem; line: InboxLine; to: string; late: number; search: string };

const TABS: Array<{ key: Tab; label: string; has: (r: Row) => boolean }> = [
  { key: 'all', label: 'All', has: () => true },
  { key: 'new', label: 'New', has: (r) => r.line.isNew },
  { key: 'approvals', label: 'Approvals', has: (r) => r.line.kind === 'approval' },
  { key: 'questions', label: 'Questions', has: (r) => ASK_KINDS.includes(r.line.kind) },
  { key: 'review', label: 'To review', has: (r) => r.line.kind !== 'approval' && !ASK_KINDS.includes(r.line.kind) },
];

const TYPE: Record<InboxLineKind, string> = {
  approval: 'Approve',
  question: 'Question',
  reply: 'Reply',
  sent_back: 'Sent back',
  sync_failed: 'QuickBooks',
  review: 'Review',
  unreadable: 'Can’t read',
  sign_off: 'Sign off',
};

const EMPTY: Record<Tab, string> = {
  all: 'Nothing is waiting on you.',
  new: 'Nothing new since you last looked.',
  approvals: 'No approvals are waiting on you.',
  questions: 'No questions for you, and no replies to yours.',
  review: 'Nothing to review.',
};

function isTab(value: string | null): value is Tab {
  return TABS.some((t) => t.key === value);
}

/** One row per thing wanted, in the order the Inbox reads. */
function rowsOf(items: InboxItem[], organizationId: string): Row[] {
  const rows = items.flatMap((item) =>
    item.lines.map((line, i): Row => {
      const to = pathOf(item, organizationId);
      const amount = item.amountUsd == null ? '' : usd(item.amountUsd);
      return {
        key: `${item.key}:${line.kind}:${i}`,
        item,
        line,
        to,
        late: item.dueAt ? daysPast(item.dueAt) : 0,
        search: [item.vendorName, item.description, item.invoiceNumber, amount, line.text, TYPE[line.kind]]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      };
    }),
  );
  const due = (r: Row) => (r.item.dueAt ? new Date(r.item.dueAt).getTime() : Number.POSITIVE_INFINITY);
  return rows.sort((a, b) =>
    LINE_ORDER.indexOf(a.line.kind) - LINE_ORDER.indexOf(b.line.kind)
    || due(a) - due(b)
    || a.line.at.localeCompare(b.line.at));
}

export function InboxPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: Tab = isTab(asked) ? asked : 'all';
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const inbox = useQuery({
    queryKey: ['inbox', organizationId],
    queryFn: () => inboxApi.get(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  const rows = useMemo(() => rowsOf(inbox.data?.items ?? [], organizationId), [inbox.data, organizationId]);
  const counts = useMemo(
    () => Object.fromEntries(TABS.map((t) => [t.key, rows.filter(t.has).length])) as Record<Tab, number>,
    [rows],
  );
  const inTab = useMemo(() => rows.filter(TABS.find((t) => t.key === tab)!.has), [rows, tab]);
  const query = search.trim().toLowerCase();
  const shown = useMemo(() => (query ? inTab.filter((r) => r.search.includes(query)) : inTab), [inTab, query]);
  // The keyboard's cursor: the row last clicked or moved to, else the first showing.
  const cursor = shown.some((r) => r.key === picked) ? picked : (shown[0]?.key ?? null);

  // Whoever is waiting on you: the people behind your approvals and questions.
  const waiting = useMemo(() => {
    const seen = new Map<string, NonNullable<InboxLine['who']>>();
    for (const r of rows) {
      if ((r.line.kind === 'approval' || r.line.kind === 'question') && r.line.who && !seen.has(r.line.who.name)) {
        seen.set(r.line.who.name, r.line.who);
      }
    }
    return [...seen.values()];
  }, [rows]);

  const setTab = (next: Tab) => {
    setParams((p) => {
      const out = new URLSearchParams(p);
      if (next === 'all') out.delete('tab');
      else out.set('tab', next);
      return out;
    }, { replace: true });
  };

  // ↑ and ↓ move through the rows showing; Enter opens the one picked. Not
  // while typing in the search, and Enter on a focused tab or link is its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      const on = e.target instanceof HTMLElement ? e.target : null;
      if (on?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Enter' && on?.closest('a, button')) return;
      const at = shown.findIndex((r) => r.key === cursor);
      if (at < 0) return;
      e.preventDefault();
      if (e.key === 'Enter') {
        navigate(shown[at]!.to);
        return;
      }
      const next = Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      setPicked(shown[next]!.key);
      scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(shown[next]!.key)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, cursor, navigate]);

  return (
    <div className="ui inbox-page">
      <div className="list-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="list-title">Inbox</h1>
          {waiting.length > 0 ? (
            <div className="ib-waiting">
              <span className="ib-faces">
                {waiting.map((p) => (
                  <span key={p.name}>
                    <Avatar name={p.name} src={p.avatarUrl} size={16} />
                  </span>
                ))}
              </span>
              <span>
                <b>
                  <span className="num">{waiting.length}</span> {waiting.length === 1 ? 'person' : 'people'}
                </b>{' '}
                {waiting.length === 1 ? 'is' : 'are'} waiting on you
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="ib-body">
        <div className="ib-bar">
          <div className="bl-stages" role="tablist" aria-label="What’s waiting">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`bl-stage${tab === t.key ? ' is-on' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <span className="bl-stage-n">{counts[t.key]}</span>
              </button>
            ))}
          </div>
          <div className="ib-tools">
            <label className="ib-search">
              <Icon.search size={11} />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearch('');
                }}
                placeholder="Search"
                aria-label="Search the Inbox"
              />
            </label>
          </div>
        </div>

        <div className="ib-scroll" ref={scroller}>
          <div className="ib-grid">
            <div className="ib-head">
              <Cells>
                <span className="ib-th">VENDOR</span>
                <span className="ib-th">DESCRIPTION</span>
                <span className="ib-th is-end">AMOUNT</span>
                <span className="ib-th">DUE</span>
                <span className="ib-th">TYPE</span>
                <span className="ib-th">WHAT’S WAITING</span>
              </Cells>
            </div>
            {shown.map((row) => (
              <InboxRow key={row.key} row={row} picked={row.key === cursor} onPick={() => setPicked(row.key)} />
            ))}
            {!inbox.isSuccess ? (
              inbox.isError ? (
                <div className="ib-empty">
                  Your Inbox couldn’t be loaded.
                  <button type="button" className="ib-clear" onClick={() => void inbox.refetch()}>
                    Try again
                  </button>
                </div>
              ) : null
            ) : shown.length > 0 ? null : query && inTab.length > 0 ? (
              <div className="ib-empty">
                Nothing in your Inbox matches “{search.trim()}”
                <button type="button" className="ib-clear" onClick={() => setSearch('')}>
                  Clear the search
                </button>
              </div>
            ) : (
              <div className="ib-empty">{EMPTY[tab]}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InboxRow({ row, picked, onPick }: { row: Row; picked: boolean; onPick: () => void }) {
  const { item, line, late } = row;
  const unreadable = line.kind === 'unreadable' && !item.description;
  return (
    <Link to={row.to} className={`ib-row${picked ? ' is-picked' : ''}`} data-row={row.key} onClick={onPick}>
      <Cells>
        <span className="ib-td ib-vendor">{item.vendorName}</span>
        <span className="ib-td ib-desc">
          {unreadable ? (
            <span className="ib-desc-text">Couldn’t be read</span>
          ) : (
            <>
              {item.description ? <span className="ib-desc-text">{item.description}</span> : null}
              {item.description && item.invoiceNumber ? <span className="ib-dot">·</span> : null}
              {item.invoiceNumber ? <span className="ib-inv num">{item.invoiceNumber}</span> : null}
            </>
          )}
        </span>
        <span className="ib-td is-end">
          {item.amountUsd == null ? <span className="ib-none">No amount</span> : <span className="ib-amt num">{usd(item.amountUsd)}</span>}
        </span>
        <span className="ib-td">
          {item.dueAt ? (
            <span
              className={`ib-due num${late > 0 ? ' is-late' : ''}`}
              title={late > 0 ? `${late} ${late === 1 ? 'day' : 'days'} overdue` : undefined}
            >
              {shortDay(item.dueAt)}
            </span>
          ) : (
            <span className="ib-none">No due date</span>
          )}
        </span>
        <span className="ib-td">
          <span className={`chip k-${line.kind}`}>{TYPE[line.kind]}</span>
        </span>
        <span className="ib-td ib-what" title={line.text}>
          {line.who ? (
            <Avatar name={line.who.name} src={line.who.avatarUrl} size={16} />
          ) : (
            <span className="ib-orb" title="Decimal agent">
              <Orb size={16} state="rest" />
            </span>
          )}
          <span className={`ib-what-text${line.who ? '' : ' is-decimal'}`}>
            {line.lead}
            {line.quote ? (
              <>
                {' '}
                <span className="ib-quote">
                  “<Figures text={line.quote} />”
                </span>
              </>
            ) : null}
          </span>
        </span>
      </Cells>
    </Link>
  );
}
