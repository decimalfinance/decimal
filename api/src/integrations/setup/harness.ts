// The setup harness: a model in a loop that picks its next step, with tools,
// instructions, saved state and limits it cannot override. The rule throughout:
// the model decides what to do next; code decides what is allowed.
//
// Something happens (a person types, the sign-in comes back, the study finishes)
// and is written to the log as a waking event. Whoever claims the turn rebuilds
// everything from the record, runs the model, and moves the pointer past the events
// it answered. A process dying mid-turn loses nothing: its lease runs out, the
// sweep wakes the setup, and the turn runs again. That is safe because no tool
// writes to the books, and answers are keyed by call.

import type { IntegrationSetup } from '@prisma/client';
import { trackBackgroundWork } from '../../infra/background.js';
import { errorToLogFields, logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { isExceptionAgentConfigured, runAgent, type AgentRun, type AgentTool, type ChatMessage } from '../../exceptions/agent.js';
import { connectorFor } from '../connectors.js';
import { doneConditions, readyForGo, stillMissing, wordsSaid } from './gates.js';
import { playbookFor, playbookVersion, type Playbook } from './playbooks.js';
import { appendEvent, claimTurn, pendingEvents, releaseTurn, setupsOwedATurn } from './record.js';
import { approvalPicture, runStudy, studiesOwed, type StudyFindings } from './study.js';
import { ASK_AT_ONCE, decimalRefs, inWords, leftOutInWords, listFor, realRefs, setupTools, type SetupAction, type Thought, type TurnContext } from './tools.js';

/** One run of the model, between hearing something and answering. */
const MODEL_CALLS_PER_TURN = 12;
const TURN_TIMEOUT_MS = 180_000;
const OUTPUT_TOKENS_PER_CALL = 4_000;

/** One setup, all told. It runs once per customer, so these are generous; they exist to stop a runaway. */
export const SETUP_TOKEN_LIMIT = 6_000_000n;
export const SETUP_TURN_LIMIT = 200;

/** Turns in a row without an answer before it stops and says so. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** The same call failing the same way before the model is told to stop trying it. */
const MAX_SAME_FAILURE = 3;
/** The conversation the model sees. Decisions live on the record, not in here. */
const HISTORY_MESSAGES = 40;
/** A loop guard: a wake-up is about one thing, and a thing does not take this many turns. */
const TURNS_PER_WAKE = 10;
const MAX_MESSAGE_CHARS = 8_000;
/** What a busy person reads in one go. Past these it goes back to the model to say again. */
const LONGEST_MESSAGE = 1_200;
const LONGEST_CLAIM = 240;
const MOST_QUESTIONS = 2;
const MAX_CLAIMS = 5;
const FEWEST_CLAIMS = 3;
/** The share of a sentence's words the claims already have that means it says the same thing. */
const SAID_TWICE = 0.7;
/** Where one sentence ends and another starts. A company's "Inc." is not the end of one. */
const SENTENCE_END = /(?<=[.!])(?<!\b(?:Inc|INC|Co|CO|Ltd|LTD|LLC|Corp|CORP|St|No|Mr|Ms|Dr)\.)[^\S\n]+(?=[\p{Lu}\p{N}“"'])/u;

const RESPOND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'claims', 'list'],
  properties: {
    message: { type: 'string', description: 'What to say to the person, in plain sentences.' },
    list: {
      type: ['string', 'null'],
      enum: ['lookalike_vendors', 'coded_two_ways', null],
      description: 'Set it when your message asks about look-alike vendors or lines coded two ways. Code writes what the question cites under your message: exact names, how much each is used, what they share. Don\'t write that out yourself.',
    },
    claims: {
      type: 'array',
      description: 'Statements about how they work, each opening the records behind it. They show under your message, so leave them out of it. Empty when there are none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'refs'],
        properties: {
          text: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' }, description: 'Refs your tools returned.' },
        },
      },
    },
  },
};

type StopReason = 'token_limit' | 'turn_limit' | 'failures';

/**
 * Whether a failed turn's error is the AI service not answering (an error status, no
 * connection, out of time) rather than the model not managing an answer. They read the
 * same on the record, and they mean different things to someone waiting.
 */
export function serviceFailed(error: string): boolean {
  return /^(OpenAI|Anthropic) (\d{3}|unreachable)\b/.test(error) || /timed out/.test(error);
}

/** What a stop says. Fixed words: at a limit the model may not be the one talking. */
function stopWords(reason: StopReason, playbook: Playbook, serviceDown: boolean): string {
  const safe = `Everything so far is saved, and nothing has changed in your ${playbook.label}.`;
  if (reason !== 'failures') {
    return `I've reached the limit on how much work one setup can use, so I've stopped here. ${safe} Someone at Decimal needs to raise the limit before I can carry on.`;
  }
  return serviceDown
    ? `The AI service I run on isn't answering, so I've stopped rather than keep trying. ${safe} Send me a message when you'd like me to try again.`
    : `I keep failing to work this out, so I've stopped rather than keep trying. ${safe} Send me a message when you'd like me to try again.`;
}

/** Ask for a turn, in the background. Safe to call any number of times. */
export function wake(setupId: string): void {
  trackBackgroundWork(runPending(setupId).catch((error) => {
    logger.warn('integration_setup.wake_failed', { setupId, ...errorToLogFields(error) });
  }));
}

/** Run the study, in the background, and wake the harness with whatever came of it. */
function startStudy(setupId: string): void {
  trackBackgroundWork(runStudy(setupId).then((finished) => {
    if (finished) wake(setupId);
  }).catch((error) => {
    logger.warn('integration_setup.study_failed', { setupId, ...errorToLogFields(error) });
  }));
}

async function runPending(setupId: string): Promise<void> {
  for (let i = 0; i < TURNS_PER_WAKE; i += 1) {
    const before = await prisma.integrationSetup.findUnique({ where: { setupId }, select: { setupId: true, handledThroughSeq: true } });
    if (!before || (await pendingEvents(before)).length === 0) return;
    const setup = await claimTurn(setupId);
    // Someone else holds it, and looks again when it lets go.
    if (!setup) return;
    let answered = false;
    try {
      answered = await takeTurn(setup);
    } finally {
      await releaseTurn(setupId);
    }
    // A turn that failed is tried again by the sweep, so a model that is down for a
    // minute costs a minute and not all three tries at once.
    if (!answered) return;
  }
  logger.warn('integration_setup.too_many_turns', { setupId });
}

/** The answer in progress: a dead turn's, if it left one, so a repeat does not leave a second. */
async function answerInProgress(setupId: string) {
  const left = await prisma.integrationSetupMessage.findFirst({ where: { setupId, role: 'assistant', status: 'running' } });
  if (left) return prisma.integrationSetupMessage.update({ where: { messageId: left.messageId }, data: { thoughts: [], createdAt: new Date() } });
  return prisma.integrationSetupMessage.create({ data: { setupId, role: 'assistant', status: 'running' } });
}

/** One turn. True if the events it took on were dealt with, one way or another. */
async function takeTurn(setup: IntegrationSetup): Promise<boolean> {
  const pending = await pendingEvents(setup);
  const last = pending.at(-1);
  if (!last) return true;
  const playbook = playbookFor(setup.system);
  const answer = await answerInProgress(setup.setupId);
  const answered = () =>
    prisma.integrationSetup.update({ where: { setupId: setup.setupId }, data: { handledThroughSeq: last.seq, consecutiveFailures: 0 } });

  if (!isExceptionAgentConfigured()) {
    await prisma.integrationSetupMessage.update({
      where: { messageId: answer.messageId },
      data: { status: 'failed', text: `I can't set up ${playbook.label} yet: no AI model is set up for this workspace.` },
    });
    await answered();
    return true;
  }

  // The limits are checked before the model is asked, not after it has spent.
  if (setup.tokensUsed >= SETUP_TOKEN_LIMIT) {
    await stop(setup, 'token_limit', playbook, answer.messageId);
    return true;
  }
  if (setup.turnsUsed >= SETUP_TURN_LIMIT) {
    await stop(setup, 'turn_limit', playbook, answer.messageId);
    return true;
  }

  const onThought = async (thought: Thought) => {
    const entry = [{ ...thought, at: new Date().toISOString() }];
    await prisma.$executeRaw`
      UPDATE integration_setup_messages SET thoughts = thoughts || ${JSON.stringify(entry)}::jsonb
      WHERE message_id = ${answer.messageId}::uuid`.catch(() => null);
  };

  const heard = [...pending].reverse().find((e) => e.kind === 'message');
  const seen = new Set<string>();
  const actions: SetupAction[] = [];
  const ctx: TurnContext = {
    setupId: setup.setupId,
    speaker: heard ? { userId: heard.actorUserId, messageId: String((heard.payload as { messageId?: string }).messageId) } : null,
    seen,
    actions,
    saved: new Map(),
    onThought,
    startStudy: () => startStudy(setup.setupId),
  };
  const tools: AgentTool[] = [
    ...withReceipt(setup.setupId, setupTools(ctx), seen),
    { name: 'respond', description: 'Finish this turn: say something to the person.', terminal: true, parameters: RESPOND_SCHEMA },
  ];

  const run = await runAgent({
    label: 'integration_setup',
    system: await systemPrompt(setup, playbook, Boolean(heard)),
    history: await conversation(setup.setupId, pending.map((e) => e.seq)),
    user: await whatHappened(pending),
    tools,
    maxTurns: MODEL_CALLS_PER_TURN,
    timeoutMs: TURN_TIMEOUT_MS,
    maxOutputTokens: OUTPUT_TOKENS_PER_CALL,
    tokenLimit: Number(SETUP_TOKEN_LIMIT - setup.tokensUsed),
    checkTerminal: async (args) => {
      const problem = await notRightYet(args, seen, setup, actions);
      if (problem) await appendEvent(setup.setupId, 'sent_back', { problem });
      return problem;
    },
  });

  await recordTurn(setup, playbook, last.seq, run);
  if (!run.ok) {
    await failedTurn(setup, playbook, answer.messageId, run);
    return false;
  }

  // Sent back and still nothing for them to do, so code does what the model was told to:
  // nobody should be left looking at a message with nothing to answer and nothing to press.
  const next = questionsIn(run.terminal.args) === 0 && actions.length === 0 ? await whatsNext(setup) : null;
  if (next && !next.call) await tools.find((t) => t.name === 'offer_go')?.run?.({}).catch(() => null);

  // Once, on the message that tells them their books are read.
  const worthKnowing = pending.some((e) => e.kind === 'study_finished') ? leftOutInWords(setup.findings as StudyFindings | null, playbook.label) : '';
  const { text, claims, dropped } = await spoken(next?.call ? { ...run.terminal.args, list: null } : run.terminal.args, seen, setup, [...ctx.saved.values()].flat(), worthKnowing);
  if (dropped.length > 0) await appendEvent(setup.setupId, 'claims_dropped', { claims: dropped });
  await prisma.integrationSetupMessage.update({
    where: { messageId: answer.messageId },
    data: { status: 'done', text, claims, actions },
  });
  if (next?.call) {
    const asking = [next.call.question, await listFor(next.call.kind, setup.setupId)].filter(Boolean).join('\n\n');
    await prisma.integrationSetupMessage.create({ data: { setupId: setup.setupId, role: 'assistant', status: 'done', text: asking } });
    await appendEvent(setup.setupId, 'asked_by_code', { key: next.call.key });
  }
  await answered();
  return true;
}

/** The refs of a claim that are real records: something a tool returned this turn, or something in this company's copy. */
function realRefsOf(claim: { refs?: unknown } | null | undefined, seen: Set<string>, setup: IntegrationSetup): Promise<string[]> {
  const given: string[] = Array.isArray(claim?.refs) ? claim.refs.filter((r: unknown): r is string => typeof r === 'string') : [];
  if (!setup.companyId) return Promise.resolve(given.filter((r) => seen.has(r)));
  return realRefs({ organizationId: setup.organizationId, system: setup.system, companyId: setup.companyId }, given, new Set([...seen, ...decimalRefs(setup.findings)]));
}

const questionsIn = (args: Record<string, unknown>) => (typeof args.message === 'string' ? args.message.match(/\?/g)?.length ?? 0 : 0);

/**
 * Claims show under the message, so a sentence they already say comes out, and that's most of
 * what makes a message long. Sent back to reword it, the model dropped the claim instead, and they
 * heard less. A question stays, whatever it repeats.
 */
export function withoutWhatClaimsSay(message: string, claims: Array<{ text?: unknown }>): string {
  const inClaims = wordsSaid(claims.map((c) => String(c?.text ?? '')));
  if (inClaims.size === 0) return message;
  const keep = (sentence: string) => {
    const words = [...wordsSaid([sentence])];
    return sentence.includes('?') || words.length === 0 || words.filter((w) => inClaims.has(w)).length / words.length < SAID_TWICE;
  };
  return message.split('\n').map((paragraph) => paragraph.split(SENTENCE_END).filter(keep).join(' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Once their books are read, a message that asks nothing and has no button leaves them with
 * nothing to do. What's next, if so: the first question still open, or, with none, Go.
 */
async function whatsNext(setup: IntegrationSetup): Promise<{ call: { key: string; kind: string; question: string } | null } | null> {
  // As this turn began: a small company can finish reading while the model is still telling them they can leave.
  if (setup.studyStatus !== 'finished') return null;
  const [fresh, connection, next] = await Promise.all([
    prisma.integrationSetup.findUniqueOrThrow({ where: { setupId: setup.setupId }, select: { status: true } }),
    connectorFor(setup.system).connection(setup.organizationId),
    prisma.integrationSetupCall.findFirst({ where: { setupId: setup.setupId, status: { not: 'answered' } }, orderBy: { createdAt: 'asc' }, select: { key: true, kind: true, question: true } }),
  ]);
  if (fresh.status !== 'open' || connection?.status !== 'connected') return null;
  return { call: next };
}

/** The rules of a good answer that code can check. What this says goes back to the model, which says it again. */
async function notRightYet(args: Record<string, unknown>, seen: Set<string>, setup: IntegrationSetup, actions: SetupAction[]): Promise<string | null> {
  const claims: Array<{ text?: unknown; refs?: unknown }> = Array.isArray(args.claims) ? args.claims : [];
  const message = withoutWhatClaimsSay(typeof args.message === 'string' ? args.message.trim() : '', claims);
  const problems: string[] = [];
  if (message.length > LONGEST_MESSAGE) {
    problems.push(`Your message is ${message.length} characters. A busy person is reading this. Say it in under ${LONGEST_MESSAGE}, and leave the rest for your next message.`);
  }
  const asked = questionsIn({ message });
  if (asked > MOST_QUESTIONS) problems.push(`You asked ${asked} questions. Ask ${MOST_QUESTIONS} at most, and the rest once they have answered.`);
  if (typeof args.list === 'string' && (claims.length > 0 || asked > 1)) {
    problems.push('A list goes in a message of its own, with the one question it asks. Send everything else now, and the list next.');
  }
  const notTold = await howTheyWorkNotTold(setup, claims.length);
  if (notTold) problems.push(notTold);
  if (asked === 0 && actions.length === 0) {
    const next = await whatsNext(setup);
    if (next) {
      problems.push(next.call
        ? `This leaves them with nothing to do. Ask ${next.call.key} in this message.`
        : 'This leaves them with nothing to do, and nothing is left to ask, so offer_go in this turn. If it says something is missing, deal with that.');
    }
  }
  if (claims.length > MAX_CLAIMS) problems.push(`You made ${claims.length} claims. Make ${MAX_CLAIMS} at most: what matters most to them.`);
  if (claims.some((c) => typeof c?.text === 'string' && c.text.length > LONGEST_CLAIM)) problems.push('Keep each claim to one short sentence, and say more if they ask.');
  for (const claim of claims) {
    if ((await realRefsOf(claim, seen, setup)).length === 0) problems.push(`This claim cites nothing real: "${String(claim?.text).slice(0, 80)}". Cite what your tools returned, or put it in message if it has no records behind it.`);
  }
  return problems.length > 0 ? problems.join(' ') : null;
}

/**
 * Step 5 is what shows it understood them, so it isn't skipped: once their books are read,
 * they hear how they work before anything else, as far as their books can say.
 */
async function howTheyWorkNotTold(setup: IntegrationSetup, claims: number): Promise<string | null> {
  const findings = setup.findings as StudyFindings | null;
  if (setup.studyStatus !== 'finished' || !findings) return null;
  const enough = Math.min(FEWEST_CLAIMS, findings.busiestVendors.length + findings.learned.sample.length + findings.movedLines.length);
  if (claims >= enough) return null;
  const said = await prisma.integrationSetupMessage.findMany({ where: { setupId: setup.setupId, role: 'assistant', status: 'done' }, select: { claims: true } });
  const told = said.flatMap((m) => (Array.isArray(m.claims) ? m.claims : [])).length;
  if (told + claims >= enough) return null;
  return `They haven't heard how they work yet. Put at least ${enough - told} claims in this message, with no list, and whatever else you need to say. get_findings has what to cite.`;
}

/**
 * What the model said, with the part code can check checked. A claim has to cite real
 * records: something a tool returned this turn, or something in this company's copy,
 * as it may be citing what it read a turn ago. One citing nothing real is dropped and
 * goes on the receipt, so a measure of it exists. The rules were sent back to it already: this is what's left if it didn't listen.
 */
async function spoken(args: Record<string, unknown>, seen: Set<string>, setup: IntegrationSetup, saved: string[], worthKnowing: string) {
  const raw = Array.isArray(args.claims) ? args.claims : [];
  const claims: Array<{ text: string; refs: string[] }> = [];
  const dropped: unknown[] = [];
  for (const claim of raw) {
    const text = typeof claim?.text === 'string' ? claim.text.trim().slice(0, 500) : '';
    const refs = await realRefsOf(claim, seen, setup);
    if (text && refs.length > 0 && claims.length < MAX_CLAIMS) claims.push({ text, refs });
    else dropped.push(claim);
  }
  // Against the claims that made it: what a dropped one said is still only said here.
  const said = withoutWhatClaimsSay(typeof args.message === 'string' ? args.message.trim().slice(0, MAX_MESSAGE_CHARS) : '', claims);
  const above = saved.length > 0 ? `Saved:\n${saved.map((line) => `- ${line}`).join('\n')}` : '';
  const list = await listFor(args.list, setup.setupId);
  return { text: [above, said || (claims.length > 0 || list || above || worthKnowing ? '' : 'Done.'), worthKnowing, list].filter(Boolean).join('\n\n'), claims, dropped };
}

/** Tokens and turns on the record, and on the receipt: which words, which model, what it cost. */
async function recordTurn(setup: IntegrationSetup, playbook: Playbook, through: bigint, run: AgentRun): Promise<void> {
  await prisma.integrationSetup.update({
    where: { setupId: setup.setupId },
    data: { tokensUsed: { increment: run.promptTokens + run.completionTokens }, turnsUsed: { increment: 1 } },
  });
  await appendEvent(setup.setupId, 'turn', {
    ok: run.ok,
    ...(run.ok ? { finishedWith: run.terminal.name } : { error: run.error, stoppedBy: run.stoppedBy ?? null }),
    through: through.toString(),
    model: run.model,
    playbook: playbookVersion(playbook),
    modelCalls: run.turns,
    latencyMs: run.latencyMs,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    // At list price. Null for a model with no listed price.
    costUsd: run.costUsd,
  });
}

async function failedTurn(setup: IntegrationSetup, playbook: Playbook, messageId: string, run: Extract<AgentRun, { ok: false }>): Promise<void> {
  if (run.stoppedBy === 'tokens') return stop(setup, 'token_limit', playbook, messageId);
  const failures = setup.consecutiveFailures + 1;
  logger.warn('integration_setup.turn_failed', { setupId: setup.setupId, failures, error: run.error });
  if (failures >= MAX_CONSECUTIVE_FAILURES) return stop(setup, 'failures', playbook, messageId, serviceFailed(run.error));
  // The pointer stays, so the same events get another turn when this one lets go.
  await prisma.integrationSetup.update({ where: { setupId: setup.setupId }, data: { consecutiveFailures: failures } });
}

/** At a limit: say so plainly, and leave the record ready to pick up from. */
async function stop(setup: IntegrationSetup, reason: StopReason, playbook: Playbook, messageId: string, serviceDown = false): Promise<void> {
  await prisma.integrationSetupMessage.update({ where: { messageId }, data: { status: 'done', text: stopWords(reason, playbook, serviceDown) } });
  await prisma.integrationSetup.update({ where: { setupId: setup.setupId }, data: { status: 'stopped', stopReason: reason } });
  await appendEvent(setup.setupId, 'stopped', { reason });
  logger.warn('integration_setup.stopped', { setupId: setup.setupId, reason });
}

/** What a call's records are called. A turn starts fresh, and an id alone gets answered with the wrong one. */
async function citesOf(setup: IntegrationSetup, calls: Array<{ refs: unknown }>): Promise<(ref: string) => { ref: string; name?: string }> {
  const refs = calls.flatMap((c) => (Array.isArray(c.refs) ? (c.refs as string[]) : []));
  const ids = (kind: string) => refs.filter((r) => r.startsWith(`${kind}:`)).map((r) => r.slice(kind.length + 1));
  const rows = setup.companyId && refs.length > 0
    ? await prisma.booksRecord.findMany({
        where: {
          organizationId: setup.organizationId, system: setup.system, companyId: setup.companyId,
          OR: [{ kind: 'vendor', recordId: { in: ids('vendor') } }, { kind: 'category', recordId: { in: ids('category') } }],
        },
        select: { kind: true, recordId: true, name: true },
      })
    : [];
  const names = new Map(rows.map((r) => [`${r.kind}:${r.recordId}`, r.name]));
  return (ref) => ({ ref, ...(names.get(ref) ? { name: names.get(ref)! } : {}) });
}

/** The playbook, and where things stand, fresh from the record: this is what a turn runs on. */
async function systemPrompt(setup: IntegrationSetup, playbook: Playbook, personSpoke: boolean): Promise<string> {
  const [connection, calls, conditions, approvals] = await Promise.all([
    connectorFor(setup.system).connection(setup.organizationId),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, orderBy: { createdAt: 'asc' } }),
    doneConditions(setup),
    approvalPicture(setup.organizationId, setup.startedByUserId),
  ]);
  const askNow = new Set(calls.filter((c) => c.status !== 'answered').slice(0, ASK_AT_ONCE).map((c) => c.key));
  const cite = await citesOf(setup, calls);
  const state = {
    signIn: connection?.status === 'connected' ? 'signed in' : connection?.status === 'needs_reauth' ? 'stopped working: they need to sign in again' : 'not signed in',
    company: setup.companyConfirmedAt ? { name: setup.companyName, confirmedByThePerson: true } : { confirmedByThePerson: false },
    readingTheirBooks: { status: setup.studyStatus ?? 'not started', attempts: setup.studyAttempts, lastFailure: setup.studyError ?? null, read: setup.studySteps },
    calls: await Promise.all(calls.map(async (c) => ({
      key: c.key, kind: c.kind, status: c.status, question: c.question, recommendation: c.recommendation, why: c.why,
      cites: (Array.isArray(c.refs) ? (c.refs as string[]) : []).map(cite),
      ...(c.answer ? { answer: c.answer, saved: await inWords(c, c.value, setup) } : {}),
      ...(c.status === 'answered' ? {} : { askNow: askNow.has(c.key) }),
    }))),
    approvals,
    goReady: readyForGo(conditions),
    stillNeededForGo: stillMissing(conditions),
    thePersonSpokeThisTurn: personSpoke,
  };
  return `${playbook.instructions}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nWhere things stand:\n${JSON.stringify(state)}`;
}

/** The conversation so far, without what this turn is answering or the answer in progress. */
async function conversation(setupId: string, pendingSeqs: bigint[]): Promise<ChatMessage[]> {
  const pending = await prisma.integrationSetupEvent.findMany({ where: { setupId, seq: { in: pendingSeqs }, kind: 'message' }, select: { payload: true } });
  const answering = new Set(pending.map((e) => (e.payload as { messageId?: string }).messageId));
  const messages = await prisma.integrationSetupMessage.findMany({
    where: { setupId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_MESSAGES + answering.size,
    select: { messageId: true, role: true, text: true, claims: true },
  });
  return messages
    .filter((m) => !answering.has(m.messageId))
    .slice(0, HISTORY_MESSAGES)
    .reverse()
    .map((m) => {
      const claims = Array.isArray(m.claims) ? (m.claims as Array<{ text: string }>).map((c) => `- ${c.text}`).join('\n') : '';
      return { role: m.role === 'user' ? 'user' : 'assistant', content: [m.text, claims].filter(Boolean).join('\n') } as ChatMessage;
    });
}

/** Things that happen besides a person typing, and only what code wrote about them. */
function describeEvent(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'started': return 'The person has just opened the setup.';
    case 'signed_in': return `The sign-in came back${payload.companyChanged ? ', to a different company than before: start again from reading it' : ''}.`;
    case 'sign_in_failed': return payload.reason === 'access_denied' ? 'The sign-in was cancelled on Intuit\'s screen.' : 'The sign-in failed.';
    case 'study_finished': return 'Reading their books has finished.';
    case 'study_failed': return `Reading their books failed: ${String(payload.kind)}. ${String(payload.message)}`;
    default: return kind.replace(/_/g, ' ');
  }
}

/** This turn's prompt: what the person said, and what else happened, in order. */
async function whatHappened(pending: Awaited<ReturnType<typeof pendingEvents>>): Promise<string> {
  const parts: string[] = [];
  for (const event of pending) {
    if (event.kind === 'message') {
      const { messageId } = event.payload as { messageId?: string };
      const message = messageId ? await prisma.integrationSetupMessage.findUnique({ where: { messageId }, select: { text: true } }) : null;
      if (message) parts.push(message.text);
    } else {
      parts.push(`[Decimal: ${describeEvent(event.kind, event.payload as Record<string, unknown>)} Nobody typed this.]`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Every call on the receipt: what was asked, whether it worked, and which records
 * it brought back, whatever the tool. A call that keeps failing the same way stops
 * being tried: the model is told to take it to the person.
 */
export function withReceipt(setupId: string, tools: AgentTool[], seen: Set<string>): AgentTool[] {
  const failures = new Map<string, number>();
  return tools.map((tool) => {
    const run = tool.run;
    if (!run) return tool;
    return {
      ...tool,
      run: async (args: Record<string, unknown>) => {
        const key = `${tool.name}:${JSON.stringify(args)}`;
        if ((failures.get(key) ?? 0) >= MAX_SAME_FAILURE) {
          await appendEvent(setupId, 'tool_call', { tool: tool.name, args, ok: false, skipped: 'failed too often' });
          return { error: 'This has failed several times. Stop trying it, and tell the person what is in the way.' };
        }
        const before = new Set(seen);
        const started = Date.now();
        try {
          const output = await run(args);
          await appendEvent(setupId, 'tool_call', {
            tool: tool.name, args, ok: true, ms: Date.now() - started, refs: [...seen].filter((id) => !before.has(id)).slice(0, 200),
          });
          return output;
        } catch (error) {
          failures.set(key, (failures.get(key) ?? 0) + 1);
          const message = error instanceof Error ? error.message : String(error);
          await appendEvent(setupId, 'tool_call', { tool: tool.name, args, ok: false, ms: Date.now() - started, error: message.slice(0, 500) });
          throw error;
        }
      },
    };
  });
}

/** Whatever a restart left behind: turns owed, and studies nobody is on. */
export async function sweepSetups(): Promise<number> {
  const [owed, studies] = await Promise.all([setupsOwedATurn(), studiesOwed()]);
  for (const setupId of owed) wake(setupId);
  for (const setupId of studies) startStudy(setupId);
  return owed.length + studies.length;
}
