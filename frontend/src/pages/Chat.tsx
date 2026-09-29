// A chat with the companion.
//
// The person asks; the companion works it out in the background and this page
// shows the work as it happens: each thing it looks at appears under
// "Working…" the moment it has looked, then the answer lands with its tables
// and the bills it rests on. Polls once a second while an answer is running.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { companionApi, type CompanionChat } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ─── Composer ─────────────────────────────────────────────────────────────
// Enter sends, Shift+Enter is a new line. Grows with what is typed.

export function Composer({ placeholder, busy, onSend, autoFocus }: {
  placeholder: string;
  busy: boolean;
  onSend: (text: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="cp-box">
      <textarea
        ref={ref}
        className="cp-input"
        rows={1}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        }}
      />
      <div className="cp-foot">
        <span className="cp-hint">{busy ? 'Working on it…' : 'Enter to send · Shift+Enter for a new line'}</span>
        <button type="button" className="cp-send" disabled={busy || !text.trim()} onClick={send} aria-label="Send">
          <Ico.send w={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Answer text ──────────────────────────────────────────────────────────
// The companion may use **bold** and "- " lists. Nothing else is interpreted,
// and nothing is injected as HTML.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <Fragment key={i}>{part}</Fragment>);
}

function AnswerText({ text, failed }: { text: string; failed?: boolean }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className={`ch-text${failed ? ' is-failed' : ''}`}>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-•]\s+/, ''))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 ? <br /> : null}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
}

// ─── One answer ───────────────────────────────────────────────────────────

type Message = CompanionChat['messages'][number];

function Thoughts({ message }: { message: Message }) {
  const running = message.status === 'running';
  const [open, setOpen] = useState(running);
  useEffect(() => { if (running) setOpen(true); }, [running]);
  if (!running && message.thoughts.length === 0) return null;
  const label = running
    ? 'Working…'
    : `Looked at ${message.thoughts.length} ${message.thoughts.length === 1 ? 'thing' : 'things'}`;
  return (
    <>
      <button type="button" className="ch-thoughts-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {running ? <span className="cc-live-dot" /> : <Ico.sparkle w={13} />}
        {label}
        <Ico.chevDown w={12} />
      </button>
      {open && message.thoughts.length > 0 ? (
        <div className="ch-thoughts">
          {message.thoughts.map((t, i) => (
            <div key={i} className="ch-thought">
              <span className="ch-thought-text">{t.text}</span>
              {t.detail ? <span className="ch-thought-detail">{t.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Answer({ message, bills, onOpenBill }: {
  message: Message;
  bills: CompanionChat['bills'];
  onOpenBill: (id: string, state: string) => void;
}) {
  const cards = message.billIds.map((id) => bills[id]).filter(Boolean);
  return (
    <div className="ch-answer">
      <Thoughts message={message} />
      {message.status !== 'running' ? <AnswerText text={message.text} failed={message.status === 'failed'} /> : null}
      {message.tables.map((t, i) => (
        <Fragment key={i}>
          {t.title ? <div className="cc-group" style={{ padding: 0 }}>{t.title}</div> : null}
          <div className="tbl-card">
            <table className="tbl tbl-slim">
              <thead><tr>{t.columns.map((c, j) => <th key={j} className={j === t.columns.length - 1 && t.columns.length > 1 ? 'num' : undefined}>{c}</th>)}</tr></thead>
              <tbody>
                {t.rows.map((r, j) => (
                  <tr key={j} style={{ cursor: 'default' }}>
                    {r.map((cell, k) => <td key={k} className={k === r.length - 1 && r.length > 1 ? 'td-num' : undefined}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Fragment>
      ))}
      {cards.length > 0 ? (
        <div className="ch-bills">
          {cards.map((b) => (
            <button key={b!.paymentOrderId} type="button" className="cc-card" onClick={() => onOpenBill(b!.paymentOrderId, b!.state)}>
              <div className="cc-card-top">
                <span className="cc-card-title">{b!.vendorName}</span>
                <span className="cc-card-amt">{usd(b!.amountUsd)}</span>
              </div>
              <div className="cc-card-meta">{b!.invoiceNumber ?? 'No invoice number'}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────

export function ChatPage() {
  const { organizationId = '', chatId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const bottom = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['companion-chat', organizationId, chatId],
    queryFn: () => companionApi.chat(organizationId, chatId),
    enabled: Boolean(organizationId && chatId),
    refetchInterval: (query) => (query.state.data?.running ? 1_000 : false),
  });
  const ask = useMutation({
    mutationFn: (text: string) => companionApi.followUp(organizationId, chatId, text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId, chatId] });
      void queryClient.invalidateQueries({ queryKey: ['companion-chats', organizationId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not send that.'),
  });
  const chat = q.data;
  const count = chat?.messages.length ?? 0;
  const lastThoughts = chat?.messages[count - 1]?.thoughts.length ?? 0;
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [count, lastThoughts]);

  const openBill = (id: string, state: string) =>
    navigate(`/organizations/${organizationId}/bills/${id}${state === 'draft' ? '/draft' : ''}`);

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead eyebrow="Ask Decimal" title={chat?.title ?? 'Chat'} />
        {q.isLoading ? <div className="skeleton" style={{ height: 240 }} /> : null}
        {q.isError ? (
          <div className="empty">
            <div className="empty-icon"><Ico.info w={22} /></div>
            <h4>This chat could not be opened</h4>
            <p>It may belong to someone else, or no longer exist.</p>
          </div>
        ) : null}
        {chat ? (
          <div className="ch-thread">
            {chat.messages.map((m) => (
              m.role === 'user'
                ? <div key={m.messageId} className="ch-user">{m.text}</div>
                : <Answer key={m.messageId} message={m} bills={chat.bills} onOpenBill={openBill} />
            ))}
            <div ref={bottom} />
          </div>
        ) : null}
      </div>
      {chat ? (
        <div className="ch-dock">
          <Composer placeholder="Ask a follow-up…" busy={chat.running || ask.isPending} onSend={(t) => ask.mutate(t)} />
        </div>
      ) : null}
    </div>
  );
}
