// The companion on a bill's own screen — an experiment, behind a switch.
//
// One note under the bill's heading, in the companion's voice: the flags it
// raised with the ways to settle them (the flag IS its finding, so it lives
// here, not in a box of its own), what it filled in from the document, where
// the categories came from and how confirming teaches it, what your inbox
// wants of you on this bill, the steps it took, and a chat where "this bill"
// means this bill.
//
// It never says it "needs" you. Everything here can be done without it: it
// fills the bill in and says what it noticed; the person works the bill.
//
// To take it out: set "companionOnBill" to false in public-config.json, or
// revert the commit that added this file (it touches BillDraft.tsx in one
// place, the mount).

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { companionApi, type BillCompanionNote, type BillDraftLine } from '../api';
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

export function BillCompanion({ organizationId, billId, lines, flags, flagHeadline, filled, onOpenBill }: {
  organizationId: string;
  billId: string;
  vendorName: string;
  /** The bill's lines, with where each category came from. */
  lines: BillDraftLine[];
  /** The bill's flag callouts, with their buttons. Rendered first. */
  flags: ReactNode;
  /** The most important flag in one line: its investigation's finding when there is one. */
  flagHeadline: string | null;
  /** What was read off the document into the form. */
  filled: { fields: number; lines: number; toLook: number; confirmed: boolean };
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
  // Lines whose category comes from one the team settled before.
  const remembered = lines.flatMap((l) => ((l.categoryFrom?.kind === 'memory' || l.categoryFrom?.kind === 'similar') && l.category
    ? [{ description: l.description, category: l.category, from: l.categoryFrom }]
    : []));
  // Links to the bill already on screen ("Open the bill", its card) go nowhere.
  const otherBills = Object.fromEntries(Object.entries(chat.data?.bills ?? {}).filter(([id]) => id !== billId));
  const running = chat.data?.running ?? false;
  const isDraft = n.verdict !== null;
  const headline = flagHeadline
    ?? (!isDraft ? n.standing
      : filled.toLook > 0 ? `Filled in from the document. ${filled.toLook} ${filled.toLook === 1 ? 'field is' : 'fields are'} worth a second look.`
        : 'Filled in from the document.');
  const filledLine = `I read the document and filled in ${filled.fields} ${filled.fields === 1 ? 'field' : 'fields'}${filled.lines > 0 ? ` and ${filled.lines} ${filled.lines === 1 ? 'line' : 'lines'}` : ''}.`;

  return (
    <div className="bn">
      <button type="button" className="bn-head" onClick={toggle} aria-expanded={open}>
        <span className="bn-who"><Ico.sparkle w={14} /> Companion</span>
        <span className="bn-line">{headline}</span>
        <span className="ch-chev"><Ico.chevDown w={13} /></span>
      </button>

      {open ? (
        <div className="bn-body">
          {flags ? <div className="bn-flags">{flags}</div> : null}

          {isDraft ? (
            <div className="bn-sec">
              <div className="bn-label">Filled in</div>
              <div className="bn-text">
                {filledLine}{' '}
                {filled.confirmed
                  ? 'A person has confirmed what I read.'
                  : filled.toLook > 0
                    ? `I'm less sure of ${filled.toLook === 1 ? 'one of them' : `${filled.toLook} of them`}: ${filled.toLook === 1 ? "it's" : "they're"} marked in amber below.`
                    : 'Everything I filled in is on the page.'}
              </div>
            </div>
          ) : null}

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
              {remembered.length === 0
                ? (lines.some((l) => l.categoryFrom) ? <>I picked one for each line from what it's for.</> : <>As saved on this bill.</>)
                : (
                  <div className="bn-steps">
                    {remembered.map((l, i) => (
                      <div key={i} className="bn-step">
                        <Ico.checkSm w={14} />
                        <span>
                          {l.description}: <strong>{l.category}</strong>
                          <span className="bn-detail">
                            {l.from.kind === 'similar'
                              ? ` · similar to "${l.from.like}" on ${l.from.invoiceNumber ?? 'an earlier bill'}`
                              : ` · like ${l.from.invoiceNumber ?? 'an earlier bill'}`}
                            {l.from.by ? `, settled by ${l.from.by}` : ''}
                          </span>
                        </span>
                      </div>
                    ))}
                    {remembered.length < lines.length ? <span className="bn-detail">I picked the rest from what each line is for.</span> : null}
                  </div>
                )}
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
