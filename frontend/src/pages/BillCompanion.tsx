// The companion on a bill's own screen — an experiment, behind a switch.
//
// One note under the bill's heading: whether the bill is ready or the one
// reason it needs you, what your inbox wants of you on it, where its categories
// came from, what the companion did reading it, and a chat where "this bill"
// means this bill. Everything it shows exists elsewhere; this only puts it
// where the bill is being worked.
//
// To take it out: set "companionOnBill" to false in public-config.json, or
// revert the commit that added this file (it touches BillDraft.tsx in one
// place, the mount).

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { companionApi, type BillCompanionNote } from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';
import { Answer, Composer } from './Chat';

const OPEN_KEY = 'decimal.billCompanion.open';

function readOpen(): boolean {
  try { return window.localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
}

function StepIcon({ status }: { status: BillCompanionNote['did'][number]['status'] }) {
  if (status === 'running') return <span className="cc-live-dot" />;
  if (status === 'failed') return <Ico.x w={14} />;
  if (status === 'noted') return <Ico.info w={14} />;
  return <Ico.checkSm w={14} />;
}

export function BillCompanion({ organizationId, billId, onOpenBill }: {
  organizationId: string;
  billId: string;
  onOpenBill: (id: string, state: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(readOpen);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [startedChatId, setStartedChatId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const note = useQuery({
    queryKey: ['bill-companion', organizationId, billId],
    queryFn: () => companionApi.billNote(organizationId, billId),
    enabled: Boolean(organizationId && billId),
    refetchInterval: (q) => (q.state.data?.did.some((s) => s.status === 'running') ? 2000 : false),
  });
  const chatId = startedChatId ?? note.data?.chatId ?? null;
  const chat = useQuery({
    queryKey: ['companion-chat', organizationId, chatId],
    queryFn: () => companionApi.chat(organizationId, chatId!),
    enabled: Boolean(chatId),
    refetchInterval: (q) => (q.state.data?.running ? 1000 : false),
  });

  const toggle = () => {
    setOpen((v) => {
      try { window.localStorage.setItem(OPEN_KEY, v ? '0' : '1'); } catch { /* a convenience only */ }
      return !v;
    });
  };
  const send = async (text: string) => {
    setSending(true);
    try {
      if (chatId) {
        await companionApi.followUp(organizationId, chatId, text);
      } else {
        const r = await companionApi.startChat(organizationId, text, billId);
        setStartedChatId(r.chatId);
      }
      await queryClient.invalidateQueries({ queryKey: ['companion-chat', organizationId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not ask that.');
    }
    setSending(false);
  };

  const n = note.data;
  if (!n) return null;
  // Links to the bill already on screen ("Open the bill", its card) go nowhere.
  const otherBills = Object.fromEntries(Object.entries(chat.data?.bills ?? {}).filter(([id]) => id !== billId));
  const running = chat.data?.running ?? false;
  const verdict = n.verdict;
  const pill = verdict
    ? verdict.ready
      ? <span className="pill pill-min pill-success">Ready</span>
      : <span className="pill pill-min pill-warning">Needs you</span>
    : null;
  const headline = verdict
    ? verdict.ready ? 'Nothing here needs a look. Confirm to send it for approval.' : verdict.reason
    : n.standing;

  return (
    <div className="bn">
      <button type="button" className="bn-head" onClick={toggle} aria-expanded={open}>
        <span className="bn-who"><Ico.sparkle w={14} /> Companion</span>
        {pill}
        <span className="bn-line">{headline}</span>
        <span className="ch-chev"><Ico.chevDown w={13} /></span>
      </button>

      {open ? (
        <div className="bn-body">
          {n.waiting.length > 0 ? (
            <div className="bn-sec">
              <div className="bn-label">Waiting on you</div>
              <div className="tick-list">
                {n.waiting.map((l, i) => (
                  <div key={i} className="tick-item bn-waiting">
                    <Ico.info w={14} />
                    <span>{l.kind === 'ask' && l.from ? `${l.from} asked: ` : ''}{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="bn-sec">
            <div className="bn-label">Categories</div>
            <div className="bn-text">
              {n.habit
                ? n.habit.source === 'manual'
                  ? <>From a habit a person set: <strong>{n.habit.category}</strong>.</>
                  : <>From a habit I learned from {n.habit.fromBills} confirmed bills: <strong>{n.habit.category}</strong>.</>
                : 'My best guess from the document. There is no habit for this vendor yet, so check them.'}
            </div>
          </div>

          {n.did.length > 0 ? (
            <div className="bn-sec">
              <button type="button" className="ch-thoughts-head" onClick={() => setStepsOpen((v) => !v)} aria-expanded={stepsOpen}>
                <Ico.sparkle w={13} /> What I did · {n.did.length} {n.did.length === 1 ? 'step' : 'steps'} <Ico.chevDown w={12} />
              </button>
              {stepsOpen ? (
                <div className="bn-steps">
                  {n.did.map((s) => (
                    <div key={s.id} className={`bn-step is-${s.status}`}>
                      <StepIcon status={s.status} />
                      <span>{s.text}{s.detail ? <span className="bn-detail"> · {s.detail}</span> : null}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {chat.data && chat.data.messages.length > 0 ? (
            <div className="ch-thread bn-chat">
              {chat.data.messages.map((m) => (m.role === 'user'
                ? <div key={m.messageId} className="ch-user">{m.text}</div>
                : <Answer key={m.messageId} message={m} bills={otherBills} onOpenBill={onOpenBill} organizationId={organizationId} chatId={chatId!} />))}
            </div>
          ) : null}
          <Composer placeholder="Ask about this bill…" busy={sending || running} onSend={(t) => void send(t)} />
        </div>
      ) : null}
    </div>
  );
}
