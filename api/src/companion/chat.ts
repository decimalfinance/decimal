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
import { chatTools, type Thought } from './chat-tools.js';

const MAX_TURNS = 8;
const TIMEOUT_MS = 90_000;
const HISTORY_MESSAGES = 12;

export type ChatTable = { title: string; columns: string[]; rows: string[][] };
export type ChatBlocks = { tables?: ChatTable[]; billIds?: string[] };

function system(today: string): string {
  return `You are Decimal's accounts-payable companion. You work for the team: you read every bill that comes in, check it, categorise it, investigate anything odd, and answer questions about their bills. Today is ${today}.

How to answer:
- Use the tools for every fact. Never guess a figure, a vendor, or a date. If the tools do not have it, say so plainly.
- Call as many tools as you need, then finish by calling respond. Do not ask the person to wait.
- Be brief and plain: a sentence or two, then a table if the answer is a list or a set of numbers. No preamble, no sign-off.
- Money is USD: write $4,500.00. Dates as 3 Sep 2026.
- Put the bills your answer rests on in billIds, using billIds the tools returned. Never invent one.
- Tables: a short title, a few columns, cells as short text. Put the amount column last, always with cents ($4,500.00). Never put a billId or any other internal id in a table or in the message: a person identifies a bill by vendor and invoice number, and billIds is where ids go.
- Words to use: bill, approval, approvers, team members, category, vendor. Never "payment order", "GL code", "multisig", "wallet".
- You cannot change anything from this chat. If asked to approve, send, clear, pay, or edit, say what you found and tell them where to do it (the bill, or the approvals page). Payments are not live in Decimal: never say a bill was paid out unless its state says paid.`;
}

const RESPOND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'tables', 'billIds'],
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
  },
};

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
      { name: 'respond', description: 'Finish with your answer.', terminal: true, parameters: RESPOND_SCHEMA },
    ];
    const run = await runAgent({
      label: 'chat',
      system: system(new Date().toISOString().slice(0, 10)),
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
    await finish({
      status: 'done',
      text: message,
      blocks: { tables, billIds } as unknown as Prisma.InputJsonValue,
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
      createdAt: m.createdAt.toISOString(),
    })),
    bills,
  };
}
