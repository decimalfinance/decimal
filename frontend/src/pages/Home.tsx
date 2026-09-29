// Home — the companion's console, and the page you land on.
//
// Three columns, because those are the three questions a person has when they
// sit down: what is the companion working on, what is waiting on me, and what
// got done. Every card is a job; opening one shows the work step by step, live
// while it runs, in the companion's own sentences. Each person sees their own
// work: the review piles for whoever reviews, approvals for an approver, and
// for an admin who is holding approvals up.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  companionApi,
  type CompanionConsole,
  type CompanionJob,
  type ConsoleDone,
  type ConsoleRunning,
  type ConsoleWaiting,
  type ConsoleWaitingKind,
} from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';
import { Composer } from './Chat';

/** Questions worth asking on day one, answered from the tools the chat has. */
const SUGGESTIONS = [
  'What is waiting on me?',
  'Which bills need a person, and why?',
  'Spend by vendor this month',
  'Who is holding approvals up?',
];

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "just now", "4 min ago", "2 hours ago", "yesterday", "3 Sep". */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return plural(Math.round(s / 3600), 'hour') + ' ago';
  if (s < 2 * 86_400) return 'yesterday';
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).toLowerCase();
}

function took(start: string, end: string | null): string | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return null;
  return ms < 60_000 ? `took ${(ms / 1000).toFixed(1)}s` : `took ${Math.round(ms / 60_000)} min`;
}

/** The order the waiting column reads in: what blocks others first. */
const WAITING_GROUPS: Array<{ kind: ConsoleWaitingKind; label: string }> = [
  { kind: 'approval', label: 'Your approval' },
  { kind: 'input', label: 'Needs your input' },
  { kind: 'sent_back', label: 'Sent back' },
  { kind: 'unreadable', label: "Couldn't read" },
  { kind: 'sign_off', label: 'Ready to sign off' },
];

/** The companion's opening line: what it is doing, and what is left for you. */
function openingLine(c: CompanionConsole): string {
  const parts: string[] = [];
  if (c.running.length > 0) parts.push(`I'm working on ${plural(c.running.length, 'document')}.`);
  if (c.waiting.length > 0) parts.push(`${plural(c.waiting.length, 'thing')} ${c.waiting.length === 1 ? 'is' : 'are'} waiting on you.`);
  else parts.push('Nothing is waiting on you.');
  const doneBills = c.done.filter((d) => d.kind === 'bill').length;
  if (doneBills > 0) parts.push(`${plural(doneBills, 'bill')} moved on ${c.since ? 'since you last looked' : 'this week'}.`);
  return parts.join(' ');
}

type Selection = { jobId: string; title: string; href: string | null };

export function HomePage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ['companion-console', organizationId],
    queryFn: () => companionApi.console(organizationId),
    enabled: Boolean(organizationId),
    // Fast while something is running, so the running column moves as the
    // work does; slow otherwise.
    refetchInterval: (query) => ((query.state.data?.running.length ?? 0) > 0 ? 2_000 : 15_000),
  });
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);
  const queryClient = useQueryClient();
  const toast = useToast();
  const ask = useMutation({
    mutationFn: (text: string) => companionApi.startChat(organizationId, text),
    onSuccess: ({ chatId }) => {
      void queryClient.invalidateQueries({ queryKey: ['companion-chats', organizationId] });
      navigate(`/organizations/${organizationId}/chat/${chatId}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not ask that.'),
  });
  const c = q.data;
  const firstName = c?.viewer.name?.trim().split(/\s+/)[0];
  const base = `/organizations/${organizationId}`;

  const hrefFor = (kind: ConsoleWaitingKind | 'done', paymentOrderId: string | null): string | null => {
    if (!paymentOrderId) return null;
    return kind === 'input' || kind === 'sign_off' || kind === 'sent_back'
      ? `${base}/bills/${paymentOrderId}/draft`
      : `${base}/bills/${paymentOrderId}`;
  };
  const open = (jobId: string | null, title: string, href: string | null) => {
    if (jobId) setSelected({ jobId, title, href });
    else if (href) navigate(href);
  };

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          greet
          eyebrow="Operations"
          title={firstName ? `${greeting}, ${firstName}` : greeting}
          desc={c ? <><Ico.sparkle w={14} /> {openingLine(c)}</> : undefined}
        />

        <section className="stack stack-16">
          <Composer placeholder="What can I help you with?" busy={ask.isPending} onSend={(t) => ask.mutate(t)} autoFocus />
          <div className="cp-chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="cp-chip" disabled={ask.isPending} onClick={() => ask.mutate(s)}>{s}</button>
            ))}
          </div>
        </section>

        {q.isLoading ? <div className="skeleton" style={{ height: 320 }} /> : null}
        {q.isError ? (
          <div className="empty">
            <div className="empty-icon"><Ico.info w={22} /></div>
            <h4>I couldn't load the console</h4>
            <p>Your bills are unaffected. Try again in a moment.</p>
          </div>
        ) : null}

        {c ? (
          <div className="cc-board">
            <div className="cc-col">
              <div className="cc-col-head"><h3>Running</h3><span className="cc-col-count">{c.running.length}</span></div>
              {c.running.length === 0 ? (
                <div className="cc-empty">Nothing running. Upload bills or forward them by email and I start right away.</div>
              ) : c.running.map((r: ConsoleRunning) => (
                <button key={r.jobId} type="button" className="cc-card" onClick={() => open(r.jobId, r.title, null)}>
                  <div className="cc-card-top"><span className="cc-card-title">{r.title}</span></div>
                  <div className="cc-card-live"><span className="cc-live-dot" />{r.step}</div>
                  <div className="cc-card-meta">started {ago(r.startedAt, now)}</div>
                </button>
              ))}
            </div>

            <div className="cc-col">
              <div className="cc-col-head"><h3>Waiting on you</h3><span className="cc-col-count">{c.waiting.length}</span></div>
              {c.waiting.length === 0 ? <div className="cc-empty">Nothing is waiting on you.</div> : null}
              {WAITING_GROUPS.map(({ kind, label }) => {
                const cards = c.waiting.filter((w) => w.kind === kind);
                if (cards.length === 0) return null;
                return (
                  <Fragment key={kind}>
                    <div className="cc-group">{label}</div>
                    {cards.map((w: ConsoleWaiting) => (
                      <button key={w.key} type="button" className="cc-card" onClick={() => open(w.jobId, w.title, hrefFor(w.kind, w.paymentOrderId))}>
                        <div className="cc-card-top">
                          <span className="cc-card-title">{w.title}</span>
                          {w.amountUsd != null ? <span className="cc-card-amt">{usd(w.amountUsd)}</span> : null}
                        </div>
                        <div className="cc-card-sub">{w.reason}</div>
                        {w.invoiceNumber ? <div className="cc-card-meta">{w.invoiceNumber}</div> : null}
                      </button>
                    ))}
                  </Fragment>
                );
              })}
            </div>

            <div className="cc-col">
              <div className="cc-col-head">
                <h3>Done</h3>
                <span className="cc-col-count">{c.done.length}</span>
              </div>
              {c.done.length === 0 ? (
                <div className="cc-empty">Nothing finished {c.since ? 'since you last looked' : 'this week'}.</div>
              ) : c.done.map((d: ConsoleDone) => (
                d.kind === 'learned' ? (
                  <div key={d.key} className="cc-card is-static">
                    <div className="cc-card-live"><Ico.sparkle w={13} />{d.outcome}</div>
                    <div className="cc-card-meta">{ago(d.at, now)}</div>
                  </div>
                ) : (
                  <button key={d.key} type="button" className="cc-card" onClick={() => open(d.jobId, d.title, hrefFor('done', d.paymentOrderId))}>
                    <div className="cc-card-top">
                      <span className="cc-card-title">{d.title}</span>
                      {d.amountUsd != null ? <span className="cc-card-amt">{usd(d.amountUsd)}</span> : null}
                    </div>
                    <div className="cc-card-sub">{d.outcome}</div>
                    <div className="cc-card-meta">{d.invoiceNumber ? `${d.invoiceNumber} · ` : ''}{ago(d.at, now)}</div>
                  </button>
                )
              ))}
            </div>
          </div>
        ) : null}

        {c && c.viewer.isAdmin && c.holding.length > 0 ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Holding approvals</h2>
                <p className="sh-desc">Who has bills waiting on them, longest wait first.</p>
              </div>
            </div>
            <div className="tbl-card">
              <table className="tbl" style={{ tableLayout: 'fixed' }}>
                <thead><tr><th style={{ width: '50%' }}>Person</th><th style={{ width: '25%' }}>Waiting</th><th style={{ width: '25%' }}>Oldest</th></tr></thead>
                <tbody>
                  {c.holding.map((h) => (
                    <tr key={h.name} style={{ cursor: 'default' }}>
                      <td>{h.name}{h.isYou ? ' (you)' : ''}</td>
                      <td>{plural(h.openCount, 'bill')}</td>
                      <td>{ago(h.waitingSince, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      {selected ? (
        <JobDrawer
          organizationId={organizationId}
          selection={selected}
          onClose={() => setSelected(null)}
          onOpenBill={(href) => navigate(href)}
        />
      ) : null}
    </div>
  );
}

/** One job, step by step. Polls while the work is still happening. */
function JobDrawer({ organizationId, selection, onClose, onOpenBill }: {
  organizationId: string;
  selection: Selection;
  onClose: () => void;
  onOpenBill: (href: string) => void;
}) {
  const q = useQuery({
    queryKey: ['companion-job', organizationId, selection.jobId],
    queryFn: () => companionApi.job(organizationId, selection.jobId),
    refetchInterval: (query) => (query.state.data?.running ? 1_000 : false),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const job: CompanionJob | undefined = q.data;
  // A running card has no bill yet; once the job made one, it can be opened.
  const href = selection.href
    ?? (job && !job.running && job.billIds[0] ? `/organizations/${organizationId}/bills/${job.billIds[0]}/draft` : null);

  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer drawer-wide" role="dialog" aria-modal="true" aria-labelledby="dec-job-title">
        <div className="drawer-head">
          <div>
            <h2 id="dec-job-title">{selection.title}</h2>
            <p>{job ? `${job.filename} · received ${clock(job.receivedAt)}` : 'Loading the work…'}</p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-body" style={{ overflowY: 'auto' }}>
          {q.isLoading ? <div className="skeleton" style={{ height: 240 }} /> : null}
          {job && job.steps.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.info w={22} /></div>
              <h4>No steps recorded</h4>
              <p>This bill came in before I wrote my work down step by step.</p>
            </div>
          ) : null}
          {job && job.steps.length > 0 ? (
            <div className="timeline">
              {job.steps.map((s) => (
                <div key={s.id} className={`tl-event ${s.status}${s.kind.includes('.') ? ' sub' : ''}`}>
                  <div className="tl-rail"><span className="tl-dot" /><span className="tl-line" /></div>
                  <div className="tl-body">
                    <div className="tl-title">{s.status === 'running' ? `${s.text}…` : s.text}</div>
                    {s.detail ? <div className="tl-detail">{s.detail}</div> : null}
                    <div className="tl-meta">{clock(s.startedAt)}{took(s.startedAt, s.finishedAt) ? ` · ${took(s.startedAt, s.finishedAt)}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="drawer-foot">
          {href ? (
            <button type="button" className="btn btn-primary" onClick={() => onOpenBill(href)}>
              Open the bill <Ico.arrowRight w={14} />
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
