// Chatting with the companion.
//
// A person asks; the companion works the answer out in the background, writing
// each thing it looks at as a thought the moment it has looked, and finishes
// with an answer: a few sentences, tables where numbers are the point, and the
// bills it rests on. The screen polls the chat and shows the work as it
// happens.
//
// It answers from tools, never from memory, and sees only what the person
// asking can see. It does not act from here: anything that changes a bill is
// done on the bill, by a person.
import { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import { trackBackgroundWork } from '../infra/background.js';
import { badRequest, notFound } from '../infra/api-errors.js';
import { isExceptionAgentConfigured, runAgent, type ChatMessage } from '../exceptions/agent.js';
import { getOrgAccess } from '../approvals/permissions.js';
import { chatTools, localDay, type Thought } from './chat-tools.js';
import { orgTools } from './chat-tools-org.js';
import { ACTION_KINDS, buildActionCards, doneText, type ActionCard, type ProposedAction } from './actions.js';

const MAX_TURNS = 8;
const TIMEOUT_MS = 90_000;
const HISTORY_MESSAGES = 12;

export type ChatTable = { title: string; columns: string[]; rows: string[][] };
export type ChatBlocks = { tables?: ChatTable[]; billIds?: string[]; actions?: ActionCard[] };

/** The server's time zone, e.g. "Asia/Kolkata (UTC+05:30)" — the one flags and screens speak in. */
function teamTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0');
  const mm = String(Math.abs(minutes) % 60).padStart(2, '0');
  return `${zone} (UTC${sign}${hh}:${mm})`;
}

type Asker = { name: string; access: string; roles: string[] };

function system(today: string, asker: Asker): string {
  return `You are Decimal's accounts-payable companion. You work for the team: you read every bill that comes in, check it, categorise it, investigate anything odd, and answer questions about their bills. Today is ${today}. The team's time zone is ${teamTimeZone()}: timestamps from tools ending in Z are UTC, so convert them before you state a date or time.

You are talking to ${asker.name} (${asker.access}${asker.roles.length ? `; roles: ${asker.roles.join(', ')}` : ''}). "I", "me" and "my" mean ${asker.name}: a bill waiting on ${asker.name}'s approval is waiting on the person you are talking to.

How to answer:
- Use the tools for every fact. Never guess a figure, a vendor, a date, or a person's responsibility. If the tools do not have it, say so plainly.
- For "who" questions (who does this, who is it waiting on, who should I ask), use team, approval_trail and bill_history, and name the people.
- A bill named by its number ("BW-2210") is found with find_bills invoiceNumber, then read with get_bill, approval_trail or bill_history.
- Call as many tools as you need, then finish by calling respond. Do not ask the person to wait.
- Be brief and plain: a sentence or two, then a table if the answer is a list or a set of numbers. No preamble, no sign-off.
- Money is USD: write $4,500.00. Dates as 3 Sep 2026.
- Put the bills your answer rests on in billIds, using billIds the tools returned. Never invent one.
- Tables: a short title, a few columns, cells as short text. Put the amount column last, always with cents ($4,500.00). Never put a billId or any other internal id in a table or in the message: a person identifies a bill by vendor and invoice number, and billIds is where ids go.
- Words to use: bill, approval, approvers, team members, category, vendor. Never "payment order", "GL code", "multisig", "wallet".
- You never change anything yourself. You can PROPOSE actions in actions, and the person clicks to carry them out:
  - send_for_approval: a draft that is ready (checked, nothing flagged).
  - close_duplicate: the copy in a duplicate pair. Keep the older bill; close the newer copy. reason says why it is a copy.
  - clear_duplicate: a duplicate flag on bills that are genuinely different. reason says why.
  - ask_person: ask a teammate to do or answer something about a bill (toPerson: their name from the team tool; message: the ask, written to them, e.g. "While you're approving this, check the tax line."). You do not decide how it is sent: the system checks their inbox and makes it a nudge (does not hold the bill), a question (holds it until they answer), or tells the person it is already there. Use it when someone asks you to chase, remind, or ask a colleague.
  - save_habit: remember that a vendor's bills go to a category (billId: any bill from that vendor; category: the name from the categories tool). For whoever codes bills.
  - forget_habit: forget a vendor's category habit (billId: any bill from that vendor). For whoever codes bills.
  - approve: a bill waiting on this person's approval (whats_waiting lists it under kind "approval"). "In approval" is exactly when to propose it. Do not second-guess the approval rules or flags: they are checked when the person clicks, and the card will say if they stop it.
  Propose when the person asks you to do something, or when one of these is plainly the next step. Propose only an action that IS what was asked: if none of the four fits (a category, an edit, a payment, a setting), propose nothing and say where it is done. Never offer a different action in its place. Say in the message what you are proposing and why; never say it is done. Anything you say you are proposing MUST be in actions: a proposal only in words is no use to anyone. Anything else (editing a bill, categories, paying) is done on the bill: say where.
- Payments are not live in Decimal: never say a bill was paid out unless its state says paid.`;
}

const RESPOND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'tables', 'billIds', 'actions'],
  properties: {
    message: { type: 'string', description: 'The answer, in plain sentences. **bold** and lines starting "- " are allowed.' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'columns', 'rows'],
        properties: {
          title: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    billIds: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      description: 'Actions to propose for the person to confirm. Empty when there is nothing to do.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'billId', 'reason', 'toPerson', 'message', 'category'],
        properties: {
          kind: { type: 'string', enum: [...ACTION_KINDS] },
          billId: { type: 'string' },
          reason: { type: 'string', description: 'One sentence: why this action, for this bill.' },
          toPerson: { type: ['string', 'null'], description: 'ask_person only: the teammate\'s name, as the team tool lists it. Null otherwise.' },
          message: { type: ['string', 'null'], description: 'ask_person only: what you are asking them, written to them. Null otherwise.' },
          category: { type: ['string', 'null'], description: 'save_habit only: the category name, exactly as the categories tool lists it. Null otherwise.' },
        },
      },
    },
  },
};

/** Who is asking, for the prompt: "I" and "me" must mean someone. */
async function askerOf(organizationId: string, userId: string): Promise<Asker> {
  const [user, access] = await Promise.all([
    prisma.user.findUnique({ where: { userId }, select: { displayName: true, email: true } }),
    getOrgAccess(organizationId, userId),
  ]);
  const ROLE_NAMES: Record<string, string> = { bill_clerk: 'Bill Clerk', approver: 'Approver', payer: 'Payer', viewer: 'Viewer' };
  const ACCESS: Record<string, string> = { primary_admin: 'primary admin', admin: 'admin', member: 'member' };
  return {
    name: user?.displayName?.trim() || user?.email || 'the person asking',
    access: ACCESS[access?.membershipRole ?? ''] ?? 'member',
    roles: (access?.roles ?? []).map((r) => ROLE_NAMES[r] ?? r),
  };
}

/**
 * An answer is worked out in this process, in the background. If the process
 * restarts mid-answer, nothing finishes it, and the chat would say "still
 * working" forever and refuse every follow-up. Past the time an answer can
 * possibly take, a running answer is marked as interrupted.
 */
const INTERRUPTED_AFTER_MS = TIMEOUT_MS + 60_000;
async function settleInterrupted(chatId: string): Promise<void> {
  await prisma.companionMessage.updateMany({
    where: { chatId, status: 'running', createdAt: { lt: new Date(Date.now() - INTERRUPTED_AFTER_MS) } },
    data: { status: 'failed', text: 'I was interrupted before I finished this one. Ask again and I will pick it up.' },
  }).catch(() => null);
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

async function ownChat(organizationId: string, userId: string, chatId: string) {
  const chat = await prisma.companionChat.findFirst({ where: { chatId, organizationId, userId } });
  if (!chat) throw notFound('No such chat.');
  return chat;
}

/** Start a chat with its first question. The answer is worked out in the background. */
export async function startChat(organizationId: string, userId: string, text: string) {
  const question = text.trim();
  if (!question) throw badRequest('Ask something.');
  const chat = await prisma.companionChat.create({
    data: { organizationId, userId, title: titleFrom(question) },
  });
  await ask(organizationId, userId, chat.chatId, question);
  return { chatId: chat.chatId };
}

/** A follow-up in an existing chat. Refused while the last answer is still being worked out. */
export async function followUp(organizationId: string, userId: string, chatId: string, text: string) {
  const question = text.trim();
  if (!question) throw badRequest('Ask something.');
  await ownChat(organizationId, userId, chatId);
  await settleInterrupted(chatId);
  const busy = await prisma.companionMessage.findFirst({ where: { chatId, status: 'running' }, select: { messageId: true } });
  if (busy) throw badRequest('Still working on the last question.');
  await ask(organizationId, userId, chatId, question);
  return { chatId };
}

async function ask(organizationId: string, userId: string, chatId: string, question: string) {
  const history = await prisma.companionMessage.findMany({
    where: { chatId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_MESSAGES,
    select: { role: true, text: true },
  });
  await prisma.companionMessage.create({ data: { chatId, role: 'user', status: 'done', text: question } });
  const answer = await prisma.companionMessage.create({ data: { chatId, role: 'assistant', status: 'running' } });
  await prisma.companionChat.update({ where: { chatId }, data: { updatedAt: new Date() } });
  trackBackgroundWork(answerQuestion({
    organizationId,
    userId,
    messageId: answer.messageId,
    question,
    history: history.reverse().map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }) as ChatMessage),
  }));
}

async function answerQuestion(args: {
  organizationId: string;
  userId: string;
  messageId: string;
  question: string;
  history: ChatMessage[];
}): Promise<void> {
  const finish = (data: Prisma.CompanionMessageUpdateInput) =>
    prisma.companionMessage.update({ where: { messageId: args.messageId }, data }).catch(() => null);
  if (!isExceptionAgentConfigured()) {
    await finish({ status: 'failed', text: 'I cannot answer questions yet: no AI model is set up for this workspace.' });
    return;
  }
  const seen = new Set<string>();
  const onThought = async (t: Thought) => {
    const entry = [{ ...t, at: new Date().toISOString() }];
    await prisma.$executeRaw`
      UPDATE companion_messages SET thoughts = thoughts || ${JSON.stringify(entry)}::jsonb WHERE message_id = ${args.messageId}::uuid`
      .catch(() => null);
  };
  try {
    const tools = [
      ...chatTools({ organizationId: args.organizationId, viewerUserId: args.userId, onThought, seen }),
      ...orgTools({ organizationId: args.organizationId, viewerUserId: args.userId, onThought, seen }),
      { name: 'respond', description: 'Finish with your answer.', terminal: true, parameters: RESPOND_SCHEMA },
    ];
    const run = await runAgent({
      label: 'chat',
      system: system(localDay(new Date()), await askerOf(args.organizationId, args.userId)),
      history: args.history,
      user: args.question,
      tools,
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
    });
    if (!run.ok) {
      await finish({ status: 'failed', text: 'I could not finish working that out. Try asking again, or more narrowly.', model: run.model, latencyMs: run.latencyMs });
      logger.warn('companion_chat.failed', { error: run.error });
      return;
    }
    const a = run.terminal.args;
    const message = typeof a.message === 'string' && a.message.trim() ? a.message.trim().slice(0, 4000) : 'Done.';
    const tables = (Array.isArray(a.tables) ? a.tables : [])
      .filter((t): t is ChatTable => Boolean(t) && Array.isArray((t as ChatTable).columns) && Array.isArray((t as ChatTable).rows))
      .slice(0, 3)
      .map((t) => ({
        title: String(t.title ?? '').slice(0, 120),
        columns: t.columns.slice(0, 8).map((c) => String(c).slice(0, 60)),
        rows: t.rows.slice(0, 50).map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => String(c).slice(0, 120))),
      }));
    // Only bills a tool actually returned. An answer pointing at a bill it
    // never looked at is exactly the invented fact this is meant to stop.
    const billIds = [...new Set((Array.isArray(a.billIds) ? a.billIds : []).map(String))].filter((id) => seen.has(id)).slice(0, 12);
    // Proposals become cards only if they fit the bill as it is now; the
    // request each button sends is built in code, never taken from the model.
    const proposals = (Array.isArray(a.actions) ? a.actions : [])
      .filter((x): x is ProposedAction => Boolean(x) && (ACTION_KINDS as readonly string[]).includes((x as ProposedAction).kind) && typeof (x as ProposedAction).billId === 'string')
      .map((x) => ({ kind: x.kind, billId: x.billId, reason: String(x.reason ?? ''), toPerson: typeof x.toPerson === 'string' ? x.toPerson : null, message: typeof x.message === 'string' ? x.message : null, category: typeof x.category === 'string' ? x.category : null }));
    const actions = await buildActionCards({ organizationId: args.organizationId, viewerUserId: args.userId, proposals, seen });
    // Never promise a button that is not there: the model said it was
    // proposing something, but no card survived (it left it out, or the bill
    // does not allow it for this person).
    const promisesACard = /\b(i'?m proposing|i propose|proposing to|here(?:'s| is) (?:a|the) card|click (?:the|to))\b/i.test(message);
    // An ask the system found already covered sends nothing; say so, so the
    // answer never reads as if a nudge is on its way when none is.
    const covered = actions.filter((c) => c.kind === 'already_asked');
    const actionable = actions.filter((c) => c.status === 'proposed');
    let answerText = promisesACard && actionable.length === 0 && covered.length === 0
      ? `${message}\n\nI could not turn that into something you can click here, so do it on the bill itself.`
      : message;
    for (const c of covered) answerText += `\n\nNothing to send: ${c.detail}`;
    await finish({
      status: 'done',
      text: answerText,
      blocks: { tables, billIds, actions } as unknown as Prisma.InputJsonValue,
      model: run.model,
      latencyMs: run.latencyMs,
    });
  } catch (error) {
    logger.warn('companion_chat.error', { ...(error instanceof Error ? { message: error.message } : {}) });
    await finish({ status: 'failed', text: 'Something went wrong on our side while I was working that out. Try again.' });
  }
}

export async function listChats(organizationId: string, userId: string) {
  const chats = await prisma.companionChat.findMany({
    where: { organizationId, userId },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { chatId: true, title: true, updatedAt: true },
  });
  return { chats: chats.map((c) => ({ chatId: c.chatId, title: c.title, updatedAt: c.updatedAt.toISOString() })) };
}

export async function getChat(organizationId: string, userId: string, chatId: string) {
  const chat = await ownChat(organizationId, userId, chatId);
  await settleInterrupted(chatId);
  const messages = await prisma.companionMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'asc' } });
  // The bills an answer points at, as cards: looked up now, so a card shows the
  // bill as it is, not as it was when the answer was written.
  const ids = [...new Set(messages.flatMap((m) => ((m.blocks as ChatBlocks | null)?.billIds ?? [])))];
  const orders = ids.length === 0 ? [] : await prisma.paymentOrder.findMany({
    where: { organizationId, paymentOrderId: { in: ids } },
    select: {
      paymentOrderId: true, state: true, invoiceNumber: true, amountRaw: true,
      counterparty: { select: { displayName: true } }, counterpartyWallet: { select: { label: true } },
    },
  });
  const bills = Object.fromEntries(orders.map((o) => [o.paymentOrderId, {
    paymentOrderId: o.paymentOrderId,
    vendorName: o.counterparty?.displayName ?? o.counterpartyWallet?.label ?? 'Unknown vendor',
    invoiceNumber: o.invoiceNumber,
    amountUsd: Number(o.amountRaw) / 1_000_000,
    state: o.state,
  }]));
  return {
    chatId: chat.chatId,
    title: chat.title,
    running: messages.some((m) => m.status === 'running'),
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role as 'user' | 'assistant',
      status: m.status as 'running' | 'done' | 'failed',
      text: m.text,
      thoughts: (m.thoughts as Array<Thought & { at: string }>) ?? [],
      tables: (m.blocks as ChatBlocks | null)?.tables ?? [],
      billIds: (m.blocks as ChatBlocks | null)?.billIds ?? [],
      actions: ((m.blocks as ChatBlocks | null)?.actions ?? []).map((c) => ({ ...c, call: { path: c.call.path, body: c.call.body, method: c.call.method ?? 'POST' } })),
      createdAt: m.createdAt.toISOString(),
    })),
    bills,
  };
}

/**
 * What happened when the person clicked a card. The click itself went to the
 * bill's own endpoint, as them; this records the outcome on the card so the
 * chat shows it, and a card can only be carried out once.
 */
export async function recordActionOutcome(organizationId: string, userId: string, chatId: string, actionId: string, outcome: { ok: boolean; message: string | null }) {
  await ownChat(organizationId, userId, chatId);
  const messages = await prisma.companionMessage.findMany({ where: { chatId, role: 'assistant' }, select: { messageId: true, blocks: true } });
  for (const m of messages) {
    const blocks = (m.blocks ?? {}) as ChatBlocks;
    const card = blocks.actions?.find((c) => c.actionId === actionId);
    if (!card) continue;
    if (card.status === 'done' || card.status === 'info') return { status: card.status, result: card.result };
    card.status = outcome.ok ? 'done' : 'failed';
    card.result = outcome.ok ? doneText(card.kind) : (outcome.message?.slice(0, 300) || 'That did not go through.');
    await prisma.companionMessage.update({ where: { messageId: m.messageId }, data: { blocks: blocks as unknown as Prisma.InputJsonValue } });
    return { status: card.status, result: card.result };
  }
  throw notFound('No such action.');
}
