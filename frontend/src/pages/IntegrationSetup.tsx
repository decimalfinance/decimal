/**
 * Setting up an accounting system (QuickBooks for now), for admins: a
 * conversation with Decimal, which has an admin sign in, reads the books, asks
 * what it can't work out, and turns posting on when someone presses Go. Beside
 * it, the steps show how far the setup has got.
 *
 * While Decimal waits on answers, the last thing in the conversation is a card
 * on the maroon band a question for you is on in a bill's conversation: one
 * question, a line to answer it on, and arrows through the others. An answer
 * written there says which question it answers, so they can go in any order.
 * Decimal also asks each question in its own words, in its messages.
 *
 * The buttons are built here from what the API returns (a sign-in, Go), never
 * from the model's words. While Decimal is working the page looks again every
 * second, and every few seconds otherwise, so each step it takes, and another
 * admin's message, shows without a reload. Intuit's sign-in comes back here.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  api,
  integrationSetupApi,
  type IntegrationSetup,
  type IntegrationSetupAction,
  type IntegrationSetupCall,
  type IntegrationSetupMessage,
  type IntegrationSystem,
} from '../api';
import { Avatar } from '../kit/Avatar';
import { Icon } from '../kit/icons';
import { useToaster } from '../kit/Toast';
import { FaceOf, Figures, Mark, Markdown, TickGlyph, chatTime } from './bill/parts';
import type { Face } from './bill/model';
import { messageOf } from './settings/parts';

const SYSTEMS: Record<IntegrationSystem, { name: string; signsIn: string }> = {
  quickbooks: { name: 'QuickBooks', signsIn: 'An admin of your QuickBooks company signs in on Intuit’s site.' },
};
const isSystem = (s: string): s is IntegrationSystem => Object.hasOwn(SYSTEMS, s);

/** Look again every second while Decimal is working, and every few seconds while it waits on someone. */
const WORKING_MS = 1000;
const WAITING_MS = 5000;
/** Just after the page opens, as when Intuit's sign-in comes back, Decimal may be about to start. */
const OPENING_MS = 10_000;

type Busy = null | 'start' | 'sign_in' | 'go';
type Work = { did: string[]; now: string };

export function IntegrationSetupPage() {
  const { organizationId = '', system = '' } = useParams();
  if (!isSystem(system)) return <Navigate to={`/organizations/${organizationId}/policies`} replace />;
  return <SetupScreen key={`${organizationId}/${system}`} organizationId={organizationId} system={system} />;
}

function SetupScreen({ organizationId, system }: { organizationId: string; system: IntegrationSystem }) {
  const { name } = SYSTEMS[system];
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const [busy, setBusy] = useState<Busy>(null);
  const [openedAt] = useState(() => Date.now());

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const isAdmin = access.data?.isPrimaryOrAdmin ?? false;

  const key = ['integration-setup', organizationId, system];
  const latest = useQuery({
    queryKey: key,
    queryFn: () => integrationSetupApi.latest(organizationId, system),
    enabled: Boolean(organizationId) && isAdmin,
    refetchInterval: (query) => {
      const setup = query.state.data?.setup;
      if (!setup || setup.status === 'done') return false;
      return working(setup) || Date.now() - openedAt < OPENING_MS ? WORKING_MS : WAITING_MS;
    },
  });
  const setup = latest.data?.setup ?? null;
  const show = (next: IntegrationSetup) => queryClient.setQueryData(key, { setup: next });
  // A finished setup whose yes no longer holds. Signed out, signing in again picks posting up;
  // off (disconnected, or another company), the way back is a new setup.
  const signInAgain = setup?.posting === 'signed_out' ? setup.signInAgain : null;
  const lapsed = setup?.posting === 'off';

  const user = session.data?.user;
  const me: Face = { name: user?.displayName || user?.email || 'You', avatarUrl: user?.avatarUrl ?? null };

  async function start() {
    setBusy('start');
    try {
      show(await integrationSetupApi.start(organizationId, system));
    } catch (e) {
      toaster.show(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function signIn(path: string) {
    setBusy('sign_in');
    try {
      const { authorizeUrl } = await integrationSetupApi.signInLink(path);
      window.location.assign(authorizeUrl);
    } catch (e) {
      toaster.show(messageOf(e));
      setBusy(null);
    }
  }

  async function go(path: string) {
    setBusy('go');
    try {
      show(await integrationSetupApi.go(path));
      toaster.show(`Posting to ${name} is on.`);
      void queryClient.invalidateQueries({ queryKey: ['accounting-status', organizationId] });
    } catch (e) {
      toaster.show(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function say(text: string, answering?: string) {
    if (!setup) return;
    show(await integrationSetupApi.say(organizationId, setup.setupId, text, answering));
  }

  const sub = !setup
    ? `Connect your ${name} company so approved bills post there.`
    : lapsed
      ? `Nothing posts to ${name} until it’s set up again.`
      : signInAgain
        ? `Decimal’s sign-in to ${name} expired, so nothing posts there until an admin signs in again.`
        : setup.status === 'done'
          ? `Approved bills post to ${setup.company.name ?? name}.`
          : 'Decimal reads your books and asks about anything it can’t work out. Nothing is posted until you press Go.';

  let body: ReactNode = null;
  if (access.isError) {
    body = <Failed what="This page" retry={() => void access.refetch()} />;
  } else if (access.isSuccess && !isAdmin) {
    body = <p className="su-empty">Only admins can set up {name}.</p>;
  } else if (latest.isError) {
    body = <Failed what="The setup" retry={() => void latest.refetch()} />;
  } else if (latest.isSuccess && (!setup || lapsed)) {
    body = <Start name={name} again={lapsed} busy={busy === 'start'} onStart={() => void start()} />;
  } else if (setup) {
    body = (
      <>
        <Conversation setup={setup} name={name} me={me} busy={busy} onSignIn={(p) => void signIn(p)} onGo={(p) => void go(p)} onSay={say} />
        <Steps setup={setup} system={system} busy={busy} onSignIn={(p) => void signIn(p)} />
      </>
    );
  }

  return (
    <div className="ui su-page">
      <header className="su-head">
        <h1 className="page-title">{name}</h1>
        {latest.isSuccess || (access.isSuccess && !isAdmin) ? <p className="page-sub">{sub}</p> : null}
        {signInAgain ? (
          <div className="page-actions">
            <button
              type="button"
              className={`btn is-primary${busy === 'sign_in' ? ' is-busy' : ''}`}
              disabled={busy !== null}
              onClick={() => void signIn(signInAgain)}
            >
              Sign in again
            </button>
          </div>
        ) : null}
      </header>
      <div className="su-body">{body}</div>
    </div>
  );
}

/** What Decimal is doing right now, or null when it's someone's turn. */
function working(setup: IntegrationSetup): Work | null {
  if (setup.status !== 'open') return null;
  const live = setup.messages.find((m) => m.role === 'assistant' && m.status === 'running');
  const thoughts = (live?.thoughts ?? []).map((t) => t.text);
  if (setup.retrying) {
    const what = setup.retrying.cause === 'service' ? 'The AI service didn’t answer' : 'That didn’t come to an answer';
    return { did: thoughts, now: `${what}, trying again (${setup.retrying.failed + 1} of ${setup.retrying.of})` };
  }
  if (thoughts.length > 0) return { did: thoughts.slice(0, -1), now: thoughts[thoughts.length - 1]! };
  if (setup.study.status === 'running' && !live) return { did: (setup.study.steps ?? []).map((s) => s.text), now: 'Reading your books' };
  if (live || setup.messages.length === 0 || setup.messages.at(-1)?.role === 'user') return { did: [], now: 'Working' };
  return null;
}

/**
 * The question on the card, while any is still open: the one the person turned
 * to; else, after an answer given on the card, that question again if Decimal
 * still waits on it, or the next one still open; else the first still open. The
 * view lists them in the order Decimal asks them, and Go waits on every one.
 */
function questionOnCard(setup: IntegrationSetup, turnedTo: string | null, answered: string | null): IntegrationSetupCall | null {
  if (setup.status !== 'open') return null;
  const calls = setup.calls;
  if (!calls.some((c) => c.status !== 'answered')) return null;
  const chosen = turnedTo ? calls.find((c) => c.key === turnedTo) : undefined;
  if (chosen) return chosen;
  const from = answered ? calls.findIndex((c) => c.key === answered) : -1;
  const order = from >= 0 ? [...calls.slice(from), ...calls.slice(0, from)] : calls;
  return order.find((c) => c.status !== 'answered') ?? null;
}

const met = (setup: IntegrationSetup, key: string) => setup.status === 'done' || setup.goConditions.some((c) => c.key === key && c.done);

/**
 * The buttons still worth pressing, by the message that offered them: each kind
 * on its latest offer only. A sign-in stays until someone has signed in, or
 * Decimal offers it again (the wrong company); Go stays while Go is possible.
 */
function liveActions(setup: IntegrationSetup): Map<string, IntegrationSetupAction[]> {
  const out = new Map<string, IntegrationSetupAction[]>();
  if (setup.status === 'done') return out;
  const said = setup.messages.filter((m) => m.role === 'assistant' && m.status === 'done');
  const lastSaid = said.at(-1)?.messageId;
  for (const kind of ['sign_in', 'go'] as const) {
    const offer = [...said].reverse().find((m) => (m.actions ?? []).some((a) => a.kind === kind));
    const action = offer?.actions?.find((a) => a.kind === kind);
    if (!offer || !action) continue;
    const worth = kind === 'go' ? setup.canGo : setup.status === 'open' && (!met(setup, 'signed_in') || offer.messageId === lastSaid);
    if (worth) out.set(offer.messageId, [...(out.get(offer.messageId) ?? []), action]);
  }
  return out;
}

/** The latest sign-in Decimal offered, for the steps to offer too while nobody has signed in. */
function signInPath(setup: IntegrationSetup): string | null {
  for (const m of [...setup.messages].reverse()) {
    const action = m.actions?.find((a) => a.kind === 'sign_in');
    if (action) return action.path;
  }
  return null;
}

function Failed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <p className="su-empty">
      {what} couldn’t be loaded.{' '}
      <button type="button" className="bl-showall" onClick={retry}>
        Try again
      </button>
    </p>
  );
}

/** Before the first setup, or once the last one's yes no longer holds: what will happen, and the button that starts it. */
function Start({ name, again, busy, onStart }: { name: string; again: boolean; busy: boolean; onStart: () => void }) {
  return (
    <div className="su-talk">
      <div className="su-thread">
        <div className="bp-row">
          <span className="bp-face">
            <FaceOf who="decimal" size={28} bg="white" />
          </span>
          <div className="bp-said">
            <div className="bp-who">
              <span className="bp-who-name">Decimal agent</span>
            </div>
            <div className="bp-msg">
              {again
                ? `Posting to ${name} is off, so nothing posts there. To turn it on again, start a new setup: you sign in, I read your books, and you press Go.`
                : `You sign in to your ${name} company, I read how your books are kept, and I ask you about anything I can’t work out. Nothing is posted until you press Go.`}
            </div>
            <div className="su-acts">
              <button type="button" className={`btn is-primary${busy ? ' is-busy' : ''}`} disabled={busy} onClick={onStart}>
                Start setup
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Conversation({ setup, name, me, busy, onSignIn, onGo, onSay }: {
  setup: IntegrationSetup;
  name: string;
  me: Face;
  busy: Busy;
  onSignIn: (path: string) => void;
  onGo: (path: string) => void;
  onSay: (text: string, answering?: string) => Promise<void>;
}) {
  const toaster = useToaster();
  const work = working(setup);
  const [pending, setPending] = useState<{ text: string; about: string | null } | null>(null);
  // The question the person turned the card to, and the last one answered on it.
  const [turnedTo, setTurnedTo] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  // What is written on each question's card and not sent yet, kept while turning through them.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const thread = useRef<HTMLDivElement>(null);
  // Follows the end of the conversation, unless the person has scrolled up to read.
  const following = useRef(true);
  const said = setup.messages.filter((m) => !(m.role === 'assistant' && m.status === 'running'));
  const actions = liveActions(setup);
  const canWrite = setup.status === 'open' || (setup.status === 'stopped' && setup.stopReason === 'failures');
  // Not while Decimal is taking a reply in: what it asks next comes of it.
  const card = work || pending ? null : questionOnCard(setup, turnedTo, answered);

  const shape = `${said.length}|${pending?.text ?? ''}|${work ? `${work.did.length}:${work.now}` : ''}|${card?.key ?? ''}`;
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [shape]);

  async function send(text: string, call?: IntegrationSetupCall) {
    following.current = true;
    setTurnedTo(null);
    if (call) setAnswered(call.key);
    setPending({ text, about: call?.question ?? null });
    try {
      await onSay(text, call?.key);
    } finally {
      setPending(null);
    }
  }

  async function answer(call: IntegrationSetupCall) {
    const words = (drafts[call.key] ?? '').trim();
    if (!words) return;
    setDrafts((d) => ({ ...d, [call.key]: '' }));
    try {
      await send(words, call);
    } catch (e) {
      setDrafts((d) => ({ ...d, [call.key]: d[call.key] || words }));
      setTurnedTo(call.key);
      toaster.show(messageOf(e));
    }
  }

  return (
    <div className="su-talk">
      <div
        ref={thread}
        className="su-thread"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {said.map((m) => (
          <Said key={m.messageId} m={m} me={me} name={name} actions={actions.get(m.messageId) ?? []} busy={busy} onSignIn={onSignIn} onGo={onGo} />
        ))}
        {card ? (
          <QuestionCard
            calls={setup.calls}
            call={card}
            draft={drafts[card.key] ?? ''}
            onDraft={(text) => setDrafts((d) => ({ ...d, [card.key]: text }))}
            onTurn={setTurnedTo}
            onAnswer={() => void answer(card)}
          />
        ) : null}
        {pending ? <PersonSaid face={me} text={pending.text} about={pending.about} sending /> : null}
        {work ? <Working work={work} /> : null}
      </div>
      {/* Stopped or finished, Decimal's last message says why there's nothing to write here. */}
      {canWrite ? (
        <div className="su-foot">
          <Reply me={me} onSend={(text) => send(text)} />
        </div>
      ) : null}
    </div>
  );
}

/** A person's message. One written on a question's card has the question it answers above it. */
function PersonSaid({ face, text, at, about, sending }: { face: Face; text: string; at?: string; about?: string | null; sending?: boolean }) {
  return (
    <div className={`bp-row${sending ? ' is-sending' : ''}`}>
      <span className="bp-face">
        <FaceOf who={face} size={28} />
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">{face.name}</span>
          {at ? <span className="bp-who-time num">{chatTime(at)}</span> : null}
        </div>
        {about ? (
          <div className="su-about clip" title={about}>
            {about}
          </div>
        ) : null}
        <div className="bp-msg">
          <Figures text={text} />
        </div>
      </div>
    </div>
  );
}

/** One message: Decimal's words, what it found in the books, and anything to press. */
function Said({ m, me, name, actions, busy, onSignIn, onGo }: {
  m: IntegrationSetupMessage;
  me: Face;
  name: string;
  actions: IntegrationSetupAction[];
  busy: Busy;
  onSignIn: (path: string) => void;
  onGo: (path: string) => void;
}) {
  if (m.role === 'user') {
    const face = m.author ? { name: m.author.name, avatarUrl: m.author.avatarUrl } : me;
    return <PersonSaid face={face} text={m.text ?? ''} at={m.createdAt} about={m.answering?.question ?? null} />;
  }
  const found = m.claims ?? [];
  return (
    <div className="bp-row">
      <span className="bp-face">
        <FaceOf who="decimal" size={28} bg="white" />
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">Decimal agent</span>
          <span className="bp-who-time num">{chatTime(m.createdAt)}</span>
        </div>
        <div className="bp-msg">
          <Markdown text={m.text ?? ''} />
        </div>
        {found.length > 0 ? (
          <div className="su-found">
            <div className="caps su-found-head">From your books</div>
            <div className="bp-msg">
              <div className="bp-md">
                <ul>
                  {found.map((claim, i) => (
                    <li key={i}>
                      <Figures text={claim.text} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div className="su-acts">
            {actions.map((action) => (action.kind === 'sign_in' ? (
              <button
                key="sign_in"
                type="button"
                className={`btn is-primary${busy === 'sign_in' ? ' is-busy' : ''}`}
                disabled={busy !== null}
                onClick={() => onSignIn(action.path)}
              >
                Sign in to {name}
              </button>
            ) : (
              <button
                key="go"
                type="button"
                className={`btn is-primary${busy === 'go' ? ' is-busy' : ''}`}
                disabled={busy !== null}
                onClick={() => onGo(action.path)}
              >
                Go
              </button>
            )))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Decimal at work: what it has done this turn, and what it's on now. */
function Working({ work }: { work: Work }) {
  return (
    <div className="bp-row" aria-live="polite">
      <span className="bp-face">
        <FaceOf who="decimal" size={28} orb="work" bg="white" />
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">Decimal agent</span>
        </div>
        <div className="bp-msg">
          {work.did.map((text, i) => (
            <div key={i} className="su-did">
              <TickGlyph size={9} />
              <span>
                <Figures text={text} />
              </span>
            </div>
          ))}
          <span className="bp-live">{work.now}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Decimal's questions, one at a time, as the last thing in the conversation:
 * the question, a line to answer it on, and arrows through the others. A
 * question already answered shows its answer, and a new one changes it.
 */
function QuestionCard({ calls, call, draft, onDraft, onTurn, onAnswer }: {
  calls: IntegrationSetupCall[];
  call: IntegrationSetupCall;
  draft: string;
  onDraft: (text: string) => void;
  onTurn: (key: string) => void;
  onAnswer: () => void;
}) {
  const i = calls.findIndex((c) => c.key === call.key);
  const before = i > 0 ? calls[i - 1] : undefined;
  const after = i >= 0 ? calls[i + 1] : undefined;
  const done = call.status === 'answered';
  const answer = typeof call.answer === 'string' && call.answer.trim() ? call.answer.trim() : null;
  return (
    <div className="bp-row is-for-you su-card">
      <span className="bp-face">
        <FaceOf who="decimal" size={28} bg="page" />
      </span>
      <div className="bp-said">
        <div className="bp-who">
          <span className="bp-who-name">Decimal agent</span>
          {calls.length > 1 ? (
            <span className="su-turn">
              <button type="button" className="su-turn-btn" aria-label="The question before" disabled={!before} onClick={() => before && onTurn(before.key)}>
                <Icon.chevLeft size={10} />
              </button>
              <span className="num">
                {i + 1} of {calls.length}
              </span>
              <button type="button" className="su-turn-btn is-next" aria-label="The next question" disabled={!after} onClick={() => after && onTurn(after.key)}>
                <Icon.chevLeft size={10} />
              </button>
            </span>
          ) : null}
        </div>
        <div className="bp-msg">
          <Figures text={call.question} />
        </div>
        <div className="bp-sub">{done ? <Figures text={answer ? `Answered · ${answer}` : 'Answered'} /> : 'Question for you'}</div>
        <div className="bp-reply-field su-card-field">
          <input
            value={draft}
            placeholder={done ? 'Change the answer…' : 'Your answer…'}
            aria-label={`Answer: ${call.question}`}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onAnswer();
              }
            }}
          />
          <button
            type="button"
            className="bp-send"
            aria-label="Send the answer"
            disabled={!draft.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAnswer}
          >
            <SendArrow />
          </button>
        </div>
      </div>
    </div>
  );
}

function SendArrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

/** The reply line: your face, the field, and send. Decimal takes a message while it's working too. */
function Reply({ me, onSend }: { me: Face; onSend: (text: string) => Promise<void> }) {
  const toaster = useToaster();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    setText('');
    try {
      await onSend(words);
    } catch (e) {
      setText((t) => t || words);
      toaster.show(messageOf(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bp-reply">
      <div className="bp-reply-me">
        <Avatar name={me.name} src={me.avatarUrl} size={28} />
        <div className="bp-reply-field">
          <input
            value={text}
            placeholder="Reply to Decimal"
            aria-label="Write a message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="bp-send"
            aria-label="Send"
            disabled={!text.trim() || sending}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send()}
          >
            <SendArrow />
          </button>
        </div>
      </div>
    </div>
  );
}

/** How far the setup has got, in the order it goes: sign in, confirm, read, answer, Go. The questions themselves are in the conversation. */
function Steps({ setup, system, busy, onSignIn }: {
  setup: IntegrationSetup;
  system: IntegrationSystem;
  busy: Busy;
  onSignIn: (path: string) => void;
}) {
  const { name, signsIn } = SYSTEMS[system];
  const company = setup.company.name;
  const signedIn = met(setup, 'signed_in');
  // Finished, but Intuit's sign-in has since run out: the yes holds and waits on a sign-in.
  const expired = setup.posting === 'signed_out';
  // Only when the conversation has no sign-in left to press: one way to do a thing at a time.
  const offered = [...liveActions(setup).values()].some((actions) => actions.some((a) => a.kind === 'sign_in'));
  const path = setup.status === 'open' && !signedIn && !offered ? signInPath(setup) : null;
  const study = setup.study.status;
  const read = setup.study.steps ?? [];
  const answered = setup.calls.filter((c) => c.status === 'answered').length;

  return (
    <aside className="su-side" aria-label="How far the setup has got">
      <h2 className="section-title">Steps</h2>
      <ol className="su-steps">
        <Step
          state={expired ? 'live' : signedIn ? 'done' : 'todo'}
          name={expired ? 'Sign-in expired' : signedIn ? 'Signed in' : `Sign in to ${name}`}
          line={expired ? `Sign in again to ${company ?? name}.` : signedIn ? company : signsIn}
        >
          {path ? (
            <button type="button" className={`btn${busy === 'sign_in' ? ' is-busy' : ''}`} disabled={busy !== null} onClick={() => onSignIn(path)}>
              Sign in to {name}
            </button>
          ) : null}
        </Step>

        <Step
          state={met(setup, 'company_confirmed') ? 'done' : 'todo'}
          name={met(setup, 'company_confirmed') ? 'Company confirmed' : 'Confirm the company'}
          line={met(setup, 'company_confirmed') ? company : company ? `Is ${company} the right one? Say so in the conversation.` : 'Once you’re signed in.'}
        />

        <Step
          state={study === 'finished' || setup.status === 'done' ? 'done' : study === 'running' ? 'live' : 'todo'}
          name={study === 'finished' || setup.status === 'done' ? 'Books read' : study === 'running' ? 'Reading your books' : study === 'failed' ? 'Reading didn’t finish' : 'Read your books'}
          line={study === null ? 'Starts once the company is confirmed.' : study === 'failed' ? 'The conversation says what happened.' : null}
        >
          {read.length > 0 ? (
            <ul className="su-subs">
              {read.map((step) => (
                <li key={step.key} className="su-sub">
                  <Figures text={step.text} />
                </li>
              ))}
            </ul>
          ) : null}
        </Step>

        <Step
          state={met(setup, 'closing_date') && met(setup, 'required_calls') ? 'done' : 'todo'}
          name="Answer Decimal’s questions"
          line={setup.calls.length === 0 ? 'Decimal asks once your books are read.' : `${answered} of ${setup.calls.length} answered`}
        />

        <Step
          state={setup.status === 'done' ? 'done' : setup.canGo ? 'live' : 'todo'}
          name={setup.status === 'done' ? (expired ? 'Go pressed' : 'Posting is on') : 'Press Go'}
          line={
            setup.status === 'done'
              ? expired
                ? 'Posting picks up where it left off once an admin signs in again.'
                : `Approved bills post to ${company ?? name}.`
              : setup.canGo
                ? 'Everything’s ready. Go is in the conversation.'
                : 'Turns posting on once the steps above are done.'
          }
        />
      </ol>
    </aside>
  );
}

function Step({ state, name, line, children }: { state: 'done' | 'live' | 'todo'; name: string; line?: string | null; children?: ReactNode }) {
  return (
    <li className="su-step">
      {state === 'done' ? <Mark tone="ok" size={14} /> : <span className={`su-ring${state === 'live' ? ' is-live' : ''}`} />}
      <div className="su-step-text">
        <div className="su-step-name">{name}</div>
        {line ? <div className="su-step-line">{line}</div> : null}
        {children}
      </div>
    </li>
  );
}
