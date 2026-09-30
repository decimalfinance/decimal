// Inbox — everything wanted of you, one item per bill.
//
// Mail-style, because that is the shape people already know: the list on the
// left, the selected bill on the right with every line in full. Selecting an
// item marks it seen. What the system needs (your approval, a question for
// you, a draft to review) clears itself when the bill moves; what people ask
// you has its own Done.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inboxApi, knowledgeApi, type InboxItem, type InboxLineKind } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (days < 1 && new Date().toDateString() === d.toDateString()) return `today at ${time}`;
  if (days < 2) return `yesterday at ${time}`;
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} at ${time}`;
}

const LINE_LABEL: Record<InboxLineKind, string> = {
  question: 'Question', approval: 'Approve', ask: 'Ask', sent_back: 'Sent back', review: 'Review', sign_off: 'Sign off', unreadable: "Can't read", sync_failed: 'QuickBooks', learned: 'Learned',
};

type Filter = 'all' | 'new' | 'approval' | 'question' | 'ask' | 'review';
const FILTERS: Array<{ key: Filter; label: string; match: (i: InboxItem) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'new', label: 'New', match: (i) => i.isNew },
  { key: 'approval', label: 'Approvals', match: (i) => i.lines.some((l) => l.kind === 'approval') },
  { key: 'question', label: 'Questions', match: (i) => i.lines.some((l) => l.kind === 'question') },
  { key: 'ask', label: 'Asks', match: (i) => i.lines.some((l) => l.kind === 'ask') },
  { key: 'review', label: 'To review', match: (i) => i.lines.some((l) => ['review', 'sign_off', 'sent_back', 'unreadable'].includes(l.kind)) },
];

/** What the main button says, from the most urgent line of the bill's own work (not an ask). */
function actionFor(item: InboxItem): string {
  const first = item.lines.find((l) => l.kind !== 'ask')?.kind;
  if (first === 'question') return 'Answer on the bill';
  if (first === 'approval') return 'Open to approve';
  if (first === 'sign_off') return 'Confirm and send';
  if (first === 'review' || first === 'sent_back') return 'Review the bill';
  return 'Open the bill';
}

export function InboxPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['inbox', organizationId],
    queryFn: () => inboxApi.get(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] });
  const items = q.data?.items ?? [];
  const shown = useMemo(() => items.filter(FILTERS.find((f) => f.key === filter)!.match), [items, filter]);
  const selected = shown.find((i) => i.key === selectedKey) ?? shown[0] ?? null;

  // Keep the selection on the same bill while the list re-sorts (a seen item
  // sorts below new ones; following position would jump to another bill).
  useEffect(() => {
    if (!selectedKey && shown[0]) setSelectedKey(shown[0].key);
  }, [selectedKey, shown]);

  // Clicking an item is looking at it. Opening the inbox is not: an item shown
  // first by default keeps its "new" until someone actually picks it.
  const pick = (item: InboxItem) => {
    setSelectedKey(item.key);
    if (item.billId && item.isNew) void inboxApi.seen(organizationId, item.billId).then(refresh).catch(() => null);
  };

  const openBill = (item: InboxItem) => {
    if (item.billId && item.isNew) void inboxApi.seen(organizationId, item.billId).catch(() => null);
    if (item.billId) navigate(`/organizations/${organizationId}/bills/${item.billId}${item.href === 'draft' ? '/draft' : ''}`);
    else navigate(`/organizations/${organizationId}/bills`);
  };
  const tick = async (askId: string) => {
    await inboxApi.tick(organizationId, askId).catch(() => null);
    void refresh();
  };
  const keepOrForget = async (habit: NonNullable<InboxItem['habit']>, keep: boolean) => {
    await (keep ? knowledgeApi.keep(organizationId, habit.ruleId) : knowledgeApi.forget(organizationId, habit.counterpartyId)).catch(() => null);
    setSelectedKey(null);
    void refresh();
  };
  const markAll = async () => {
    await inboxApi.seenAll(organizationId).catch(() => null);
    void refresh();
  };

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Operations"
          title="Inbox"
          desc="Everything waiting on you, one item per bill. What the system needs clears itself when the bill moves; what people ask you has its own Done."
          actions={q.data && q.data.newCount > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void markAll()}>Mark all as read</button>
          ) : undefined}
        />

        <div className="filterbar">
          <div className="tabs">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className={`tab${filter === f.key ? ' on' : ''}`} onClick={() => { setFilter(f.key); setSelectedKey(null); }}>
                {f.label}<span className="tab-count">{items.filter(f.match).length}</span>
              </button>
            ))}
          </div>
        </div>

        {q.isLoading ? <div className="skeleton" style={{ height: 320 }} /> : null}
        {q.data && shown.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Ico.checkSm w={22} /></div>
            <h4>{filter === 'all' ? 'Nothing is waiting on you' : 'Nothing here'}</h4>
            <p>{filter === 'all' ? 'When a bill needs you — an approval, a question, a review — it lands here.' : 'Nothing in your inbox matches this.'}</p>
          </div>
        ) : null}

        {selected ? (
          <div className="ib-page">
            <div className="ib-list">
              {shown.map((item) => (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  className={`cc-card${item.key === selected.key ? ' is-selected' : ''}`}
                  onClick={() => pick(item)}
                  onKeyDown={(e) => { if (e.key === 'Enter') pick(item); }}
                >
                  <div className="cc-card-top">
                    <span className="cc-card-title">{item.vendorName}</span>
                    {item.isNew ? <span className="ib-new" aria-label="New" /> : null}
                    {item.amountUsd != null ? <span className="cc-card-amt">{usd(item.amountUsd)}</span> : null}
                  </div>
                  <div className="ib-lines">
                    {item.lines.slice(0, 2).map((l, i) => (
                      <div key={l.askId ?? `${l.kind}:${i}`} className={`ib-line is-${l.kind}`}>
                        <span className="ib-kind">{LINE_LABEL[l.kind]}</span>
                        <span className="ib-text">{l.kind === 'ask' ? `${l.from ?? 'Someone'}: ${l.text}` : l.text}</span>
                      </div>
                    ))}
                    {item.lines.length > 2 ? <div className="cc-card-meta">+ {item.lines.length - 2} more</div> : null}
                  </div>
                  {item.invoiceNumber ? <div className="cc-card-meta">{item.invoiceNumber}</div> : null}
                </div>
              ))}
            </div>

            <div className="surface ib-detail">
              <div className="ib-detail-head">
                <h2>{selected.vendorName}</h2>
                {selected.amountUsd != null ? <span className="ib-detail-amt">{usd(selected.amountUsd)}</span> : null}
              </div>
              <div className="ib-detail-meta">
                {[selected.invoiceNumber, selected.status, selected.dueAt ? `due ${new Date(selected.dueAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : null].filter(Boolean).join(' · ')}
              </div>
              <div className="ib-detail-lines">
                {selected.lines.map((l, i) => (
                  <div key={l.askId ?? `${l.kind}:${i}`} className={`ib-detail-line ib-line is-${l.kind}`}>
                    <span className="ib-kind">{LINE_LABEL[l.kind]}</span>
                    <div className="ib-detail-body">
                      <div className="ib-detail-text">{l.kind === 'ask' ? <><strong>{l.from ?? 'Someone'}:</strong> {l.text}</> : l.text}</div>
                      <div className="ib-detail-when">{l.kind === 'ask' || l.kind === 'question' ? 'Asked' : 'Since'} {when(l.at)}</div>
                    </div>
                    {l.askId ? <button type="button" className="ib-tick" onClick={() => void tick(l.askId!)}>Done</button> : null}
                  </div>
                ))}
              </div>
              <div className="ib-detail-foot">
                {selected.habit ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => void keepOrForget(selected.habit!, true)}>Keep it</button>
                    <button type="button" className="btn btn-secondary" onClick={() => void keepOrForget(selected.habit!, false)}>Forget it</button>
                    <button type="button" className="btn btn-ghost" onClick={() => navigate(`/organizations/${organizationId}/knowledge`)}>See what I know</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => openBill(selected)}>
                    {selected.billId ? actionFor(selected) : 'Go to bills'} <Ico.arrowRight w={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
