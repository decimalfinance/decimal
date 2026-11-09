// What the routes do with a setup: start one, take a message, hear the sign-in come
// back, take the person's yes, show it.

import { Prisma, type IntegrationSetup } from '@prisma/client';
import { postingOf } from '../../accounting/account-sync.js';
import { ApiError, badRequest, conflict, notFound } from '../../infra/api-errors.js';
import { prisma } from '../../infra/prisma.js';
import { connectorFor, type BooksConnection } from '../connectors.js';
import { deleteCopy, isDate, lookUp, type RecordKind } from '../copy.js';
import { linesToDecide } from './findings.js';
import { doneConditions, readyForGo, stillMissing } from './gates.js';
import { MAX_CONSECUTIVE_FAILURES, serviceFailed, wake } from './harness.js';
import { parseOutcome, type SetupOutcome } from './outcome.js';
import { playbookFor } from './playbooks.js';
import { appendEvent, cardAnswers, liveSetup, type SetupSystem } from './record.js';
import type { StudyFindings } from './study.js';
import { leftOutLines } from './tools.js';

/** Start a setup, or come back to the one under way. Only one runs per organisation and system. */
export async function startSetup(organizationId: string, userId: string, system: SetupSystem) {
  const connector = connectorFor(system);
  if (connector.available && !connector.available()) throw notFound(`${playbookFor(system).label} isn't available here.`);
  const existing = await liveSetup(organizationId, system);
  if (existing) return setupView(existing);
  const setup = await prisma.$transaction(async (tx) => {
    const created = await tx.integrationSetup.create({ data: { organizationId, system, startedByUserId: userId } });
    await tx.integrationSetupEvent.create({ data: { setupId: created.setupId, kind: 'started', wakes: true, actorUserId: userId } });
    return created;
  }).catch(async (error: unknown) => {
    // Two people pressing start at once: the partial unique index lets one through.
    const winner = await liveSetup(organizationId, system);
    if (winner) return winner;
    throw error;
  });
  wake(setup.setupId);
  return setupView(setup);
}

async function ownSetup(organizationId: string, setupId: string): Promise<IntegrationSetup> {
  const setup = await prisma.integrationSetup.findFirst({ where: { setupId, organizationId } });
  if (!setup) throw notFound('No such setup.');
  return setup;
}

/**
 * A person's message. Taken while a turn is running too: it waits on the log and
 * gets the next turn, so someone can say "wrong company" without waiting.
 * Written on a question's card, it says which call it answers (`answering`).
 */
export async function postMessage(organizationId: string, userId: string, setupId: string, text: string, answering: string | null = null) {
  const setup = await ownSetup(organizationId, setupId);
  if (setup.status === 'done') throw conflict('This setup is finished.');
  if (setup.status === 'stopped' && setup.stopReason !== 'failures') {
    throw conflict('This setup has reached its limit. Someone at Decimal needs to raise it.');
  }
  if (answering && !(await prisma.integrationSetupCall.findUnique({ where: { setupId_key: { setupId, key: answering } }, select: { key: true } }))) {
    throw badRequest('That question isn’t in this setup.');
  }
  const message = await prisma.integrationSetupMessage.create({ data: { setupId, role: 'user', status: 'done', authorUserId: userId, text } });
  await appendEvent(setupId, 'message', { messageId: message.messageId, ...(answering ? { answering } : {}) }, { actorUserId: userId, wakes: true });
  if (setup.status === 'stopped') {
    // It stopped because it kept failing. A person asking again is the way back.
    await prisma.integrationSetup.update({ where: { setupId }, data: { status: 'open', stopReason: null, consecutiveFailures: 0 } });
    await appendEvent(setupId, 'resumed', {}, { actorUserId: userId });
  }
  wake(setupId);
  return setupView(await ownSetup(organizationId, setupId));
}

/**
 * The sign-in came back. Only the tokens have been saved, so nothing has changed in
 * the books. A different company than before starts the setup's knowledge over:
 * what the person confirmed and answered was about the other books.
 */
export async function noteSignedIn(organizationId: string, system: string, companyId: string): Promise<void> {
  const setup = await liveSetup(organizationId, system);
  if (!setup) return;
  const companyChanged = setup.companyId !== null && setup.companyId !== companyId;
  await prisma.integrationSetup.update({
    where: { setupId: setup.setupId },
    data: {
      studyAttempts: 0,
      ...(companyChanged ? {
        companyId: null,
        companyName: null,
        companyConfirmedAt: null,
        companyConfirmedByUserId: null,
        studyStatus: null,
        studyLeaseUntil: null,
        studySteps: [],
        studyError: Prisma.DbNull,
        findings: Prisma.DbNull,
      } : {}),
    },
  });
  if (companyChanged) {
    await prisma.integrationSetupCall.deleteMany({ where: { setupId: setup.setupId } });
    await deleteCopy(organizationId, system);
  }
  await appendEvent(setup.setupId, 'signed_in', { companyId, companyChanged }, { wakes: true });
  wake(setup.setupId);
}

/** The sign-in did not work. The reason comes off a URL, so only a known word gets through. */
export async function noteSignInFailed(organizationId: string, system: string, reason: string | null): Promise<void> {
  const setup = await liveSetup(organizationId, system);
  if (!setup) return;
  await appendEvent(setup.setupId, 'sign_in_failed', { reason: reason === 'access_denied' ? 'access_denied' : 'other' }, { wakes: true });
  wake(setup.setupId);
}

/** Disconnecting takes the copy with it. A setup under way carries on, and has to sign in again. */
export async function noteDisconnected(organizationId: string, system: string): Promise<void> {
  await deleteCopy(organizationId, system);
  const setup = await liveSetup(organizationId, system);
  if (!setup) return;
  await prisma.integrationSetup.update({
    where: { setupId: setup.setupId },
    data: { companyId: null, companyName: null, companyConfirmedAt: null, companyConfirmedByUserId: null, studyStatus: null, studySteps: [], studyError: Prisma.DbNull, findings: Prisma.DbNull },
  });
  await prisma.integrationSetupCall.deleteMany({ where: { setupId: setup.setupId } });
  await appendEvent(setup.setupId, 'disconnected', {});
}

/** What the person's calls come to, as data. Fixed code reads this when it codes and posts a bill. */
async function outcomeOf(setup: IntegrationSetup, postingFrom: Date): Promise<SetupOutcome> {
  const calls = await prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId, status: 'answered' } });
  const valueOf = <T>(kind: string) => calls.filter((c) => c.kind === kind && c.value !== null).map((c) => c.value as T);
  const findings = setup.findings as StudyFindings | null;
  const lineChoices = valueOf<{ choices: SetupOutcome['lineChoices'] }>('coded_two_ways').flatMap((v) => v.choices);
  return {
    companyId: setup.companyId,
    postingFrom: postingFrom.toISOString(),
    closingDate: valueOf<{ date: string | null }>('closing_date')[0]?.date ?? null,
    vendorLinks: valueOf<{ links: SetupOutcome['vendorLinks'] }>('lookalike_vendors').flatMap((v) => v.links),
    lineChoices,
    learnedLines: await linesToLearn(setup, findings, lineChoices, postingFrom),
    categoriesInUse: findings?.accountsBillsUse.map((a) => a.id) ?? [],
    leftOut: findings?.leftOut.map((c) => c.kind) ?? [],
  };
}

/** What repeated in the books, with what the person said in place of it. "A person picks each time" leaves nothing to fill in. */
async function linesToLearn(setup: IntegrationSetup, findings: StudyFindings | null, choices: SetupOutcome['lineChoices'], postingFrom: Date): Promise<SetupOutcome['learnedLines']> {
  const same = (a: { vendorId: string; line: string | null }, b: { vendorId: string; line: string | null }) => a.vendorId === b.vendorId && a.line === b.line;
  const picked = choices.filter((c) => c.line && c.categoryId);
  const rows = picked.length > 0 && setup.companyId
    ? await prisma.booksRecord.findMany({
        where: { organizationId: setup.organizationId, system: setup.system, companyId: setup.companyId, kind: 'category', recordId: { in: picked.map((c) => c.categoryId!) } },
        select: { recordId: true, name: true },
      })
    : [];
  const decided = linesToDecide(findings);
  return [
    ...(findings?.learnedLines ?? [])
      .filter((l) => !choices.some((c) => same(c, l)))
      .map(({ vendorId, line, example, categoryName, lines, lastUsed, number }) => ({ vendorId, line, example, categoryName, lines, lastUsed, number })),
    ...picked.flatMap((c) => {
      const categoryName = rows.find((r) => r.recordId === c.categoryId)?.name;
      if (!categoryName) return [];
      const was = decided.find((l) => same(c, l));
      // A line that moved says only where it went. One coded two ways says how much.
      const used = was?.accounts.find((a) => a.id === c.categoryId);
      return [{
        vendorId: c.vendorId, line: c.line!, example: was?.example ?? c.line!, categoryName,
        lines: used && 'lines' in used ? Number(used.lines) : 0,
        lastUsed: postingFrom.toISOString(), number: null,
      }];
    }),
  ];
}

/**
 * The person's yes. A click reaches this, as the person who clicked, and no tool
 * does. Code checks the done conditions again here, whatever was offered earlier.
 */
export async function goLive(organizationId: string, userId: string, setupId: string) {
  const setup = await ownSetup(organizationId, setupId);
  // A double click: the first one did it.
  if (setup.status === 'done') return setupView(setup);
  const conditions = await doneConditions(setup);
  if (!readyForGo(conditions)) {
    throw new ApiError(409, 'setup_not_ready', 'This setup is not ready to go.', { stillNeeded: stillMissing(conditions) });
  }
  const connector = connectorFor(setup.system);
  const postingFrom = await connector.enablePosting(organizationId, userId);
  if (!postingFrom) throw new ApiError(409, 'not_connected', 'The connection is no longer live.');
  const outcome = await outcomeOf(setup, postingFrom);
  const label = playbookFor(setup.system).label;
  const { count } = await prisma.integrationSetup.updateMany({
    where: { setupId, status: { not: 'done' } },
    data: { status: 'done', stopReason: null, outcome },
  });
  // Two clicks at once: the other one said it.
  if (count === 0) return setupView(await ownSetup(organizationId, setupId));
  await prisma.integrationSetupMessage.create({
    data: {
      setupId,
      role: 'assistant',
      status: 'done',
      text: connector.posts
        ? `Done. Posting is on. Nothing already in ${label} changed.`
        : `Done. That was a rehearsal: Decimal doesn't post to ${label} yet, so nothing will post there. Nothing in ${label} changed.`,
    },
  });
  await appendEvent(setupId, 'go', { companyId: setup.companyId, companyName: setup.companyName, postingFrom: postingFrom.toISOString() }, { actorUserId: userId });
  return setupView(await ownSetup(organizationId, setupId));
}

export async function getSetup(organizationId: string, setupId: string) {
  return setupView(await ownSetup(organizationId, setupId));
}

/** What the setup screen opens on: the latest setup, finished or not, without starting one. Null before the first. */
export async function latestSetup(organizationId: string, system: SetupSystem) {
  const setup = await prisma.integrationSetup.findFirst({ where: { organizationId, system }, orderBy: { createdAt: 'desc' } });
  return setup ? setupView(setup) : null;
}

/** A record behind a claim or a call, opened. */
export async function getRecord(organizationId: string, setupId: string, kind: RecordKind, recordId: string) {
  const setup = await ownSetup(organizationId, setupId);
  if (!setup.companyId) throw notFound('No such record.');
  const { rows } = await lookUp({ organizationId, system: setup.system, companyId: setup.companyId }, kind, { id: recordId });
  if (!rows[0]) throw notFound('No such record.');
  return rows[0];
}

/** The receipt: every turn, tool call and state change, in order. */
export async function getReceipt(organizationId: string, setupId: string) {
  const setup = await ownSetup(organizationId, setupId);
  const events = await prisma.integrationSetupEvent.findMany({ where: { setupId }, orderBy: { seq: 'asc' } });
  return {
    setupId,
    tokensUsed: Number(setup.tokensUsed),
    turnsUsed: setup.turnsUsed,
    events: events.map((e) => ({ seq: Number(e.seq), at: e.at.toISOString(), actorUserId: e.actorUserId, kind: e.kind, payload: e.payload })),
  };
}

/**
 * A turn that got no answer and waits to be tried again: how many tries failed, how many
 * it gets before it stops, and whether the AI service didn't answer or the model didn't
 * manage to. Without it, someone waiting sees "working" for as long as the retries take.
 */
async function retrying(setup: IntegrationSetup) {
  if (setup.status !== 'open' || setup.consecutiveFailures === 0) return null;
  const last = await prisma.integrationSetupEvent.findFirst({ where: { setupId: setup.setupId, kind: 'turn' }, orderBy: { seq: 'desc' }, select: { payload: true } });
  const error = (last?.payload as { error?: unknown } | null)?.error;
  return { failed: setup.consecutiveFailures, of: MAX_CONSECUTIVE_FAILURES, cause: typeof error === 'string' && serviceFailed(error) ? 'service' : 'answer' };
}

/**
 * What a finished setup's yes amounts to now. Signed out keeps it: signing in
 * again to the same company picks posting up where it left off. Off (a
 * disconnect, or a sign-in to another company) takes a new setup.
 */
function postingNow(setup: IntegrationSetup, connection: BooksConnection | null): 'on' | 'signed_out' | 'off' {
  if (!connection?.postingSince || connection.companyId !== setup.companyId) return 'off';
  if (connection.status === 'connected') return 'on';
  return connection.status === 'needs_reauth' ? 'signed_out' : 'off';
}

// ─── After Go ─────────────────────────────────────────────────────────────────

/** Long enough for the books to answer, short enough that the screen doesn't wait on them. */
const BOOKS_READ_MS = 8000;

/** The latest finished setup: the one posting goes by, and the one the screen after setup shows. */
const finishedSetup = (organizationId: string, system: string) =>
  prisma.integrationSetup.findFirst({ where: { organizationId, system, status: 'done' }, orderBy: { createdAt: 'desc' } });

/**
 * The closing date the books keep themselves, which posting goes by when there is one
 * (closedThrough in account-sync.ts). Null when they keep none; undefined when they
 * couldn't be read just now, so nobody is told which date is in force on a guess.
 */
async function closingDateInBooks(setup: IntegrationSetup): Promise<string | null | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const read = (async () => {
    const reader = await connectorFor(setup.system).reader(setup.organizationId);
    if (!reader || reader.companyId !== setup.companyId) return undefined;
    const date = (await reader.closingDate())?.slice(0, 10) ?? null;
    return date && isDate(date) ? date : null;
  })();
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), BOOKS_READ_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, late]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const listOf = (names: string[]) => `${names.slice(0, -1).join(', ')}${names.length > 1 ? ' and ' : ''}${names.at(-1) ?? ''}`;

/** Names for the vendors and categories an outcome keeps by id: from what the study found, else from the copy of the books. */
async function namesFor(setup: IntegrationSetup, outcome: SetupOutcome | null, findings: StudyFindings | null) {
  const vendors = new Map<string, string>();
  const categories = new Map<string, string>();
  for (const group of findings?.lookalikeVendors ?? []) for (const v of group.vendors) vendors.set(v.id, v.name);
  for (const t of linesToDecide(findings)) {
    vendors.set(t.vendorId, t.vendorName);
    for (const a of t.accounts) categories.set(a.id, a.name);
  }
  for (const a of findings?.accountsBillsUse ?? []) if (!categories.has(a.id)) categories.set(a.id, a.name);
  const unknown = (ids: Array<string | null>, known: Map<string, string>) => [...new Set(ids.filter((id): id is string => id !== null && !known.has(id)))];
  const vendorIds = unknown([...(outcome?.vendorLinks ?? []).flatMap((l) => l.vendorIds), ...(outcome?.lineChoices ?? []).map((c) => c.vendorId)], vendors);
  const categoryIds = unknown((outcome?.lineChoices ?? []).map((c) => c.categoryId), categories);
  if (setup.companyId && vendorIds.length + categoryIds.length > 0) {
    const rows = await prisma.booksRecord.findMany({
      where: {
        organizationId: setup.organizationId,
        system: setup.system,
        companyId: setup.companyId,
        OR: [{ kind: 'vendor', recordId: { in: vendorIds } }, { kind: 'category', recordId: { in: categoryIds } }],
      },
      select: { kind: true, recordId: true, name: true },
    });
    for (const r of rows) if (r.name) (r.kind === 'vendor' ? vendors : categories).set(r.recordId, r.name);
  }
  return { vendor: (id: string) => vendors.get(id) ?? `Vendor ${id}`, category: (id: string) => categories.get(id) ?? `Category ${id}` };
}

/**
 * A finished setup, for the screen after it: who turned posting on and when, the closing date
 * the person gave, and what they decided, in words written here from the outcome posting reads.
 * Nothing here reads the books, so the view stays as quick as the database.
 */
async function finishedView(setup: IntegrationSetup) {
  const outcome = parseOutcome(setup.outcome);
  const findings = setup.findings as StudyFindings | null;
  const person = { select: { userId: true, displayName: true, email: true, avatarUrl: true } } as const;
  const [go, changed, names] = await Promise.all([
    prisma.integrationSetupEvent.findFirst({ where: { setupId: setup.setupId, kind: 'go' }, orderBy: { seq: 'asc' }, select: { at: true, actorUser: person } }),
    prisma.integrationSetupEvent.findFirst({ where: { setupId: setup.setupId, kind: 'closing_date_changed' }, orderBy: { seq: 'desc' }, select: { at: true, actorUser: person } }),
    namesFor(setup, outcome, findings),
  ]);
  const face = (u: { userId: string; displayName: string | null; email: string; avatarUrl: string | null } | null) =>
    u ? { userId: u.userId, name: u.displayName?.trim() || u.email, avatarUrl: u.avatarUrl } : null;
  const lines = linesToDecide(findings);
  const learned = outcome?.learnedLines ?? [];
  return {
    postingFrom: outcome?.postingFrom ?? go?.at.toISOString() ?? null,
    by: face(go?.actorUser ?? null),
    closingDate: {
      /** What the person said, in the setup or since. Null means never closed. The books' own wins when they keep one: see booksClosingDate. */
      said: outcome?.closingDate ?? null,
      changed: changed ? { at: changed.at.toISOString(), by: face(changed.actorUser) } : null,
    },
    decisions: [
      ...(outcome?.vendorLinks ?? []).map((l) => {
        const keep = names.vendor(l.useVendorId);
        const others = l.vendorIds.filter((id) => id !== l.useVendorId).map(names.vendor);
        return { title: keep, line: `Bills for ${listOf(others)} post to ${keep} too. They’re one business.`, value: null };
      }),
      ...(outcome?.lineChoices ?? []).map((c) => {
        const entry = lines.find((t) => t.vendorId === c.vendorId && t.line === c.line);
        const vendor = names.vendor(c.vendorId);
        const what = entry?.example ?? c.line;
        return {
          title: what ? `“${what}” from ${vendor}` : `${vendor}’s bills`,
          line: c.categoryId === null
            ? 'Coded more than one way in the past, so a person picks the Category on each bill.'
            : `Coded more than one way in the past. It goes to ${names.category(c.categoryId)} from now on.`,
          value: c.categoryId === null ? 'Picked each time' : names.category(c.categoryId),
        };
      }),
    ],
    fromHistory: { lines: learned.length, vendors: new Set(learned.map((l) => l.vendorId)).size },
    worthKnowing: leftOutLines(findings, playbookFor(setup.system)),
  };
}

/**
 * The closing date moves as the months close, so an admin changes it on the screen after
 * setup, and posting goes by it from the next bill. Null: the books have never been closed.
 */
export async function changeClosingDate(organizationId: string, userId: string, setupId: string, date: string | null) {
  const setup = await ownSetup(organizationId, setupId);
  if (setup.status !== 'done') throw conflict('Until Go, the closing date is agreed in the conversation.');
  // Posting reads the finished setup written last (readOutcome), so changing an earlier one would put its decisions back in force.
  if ((await finishedSetup(organizationId, setup.system))?.setupId !== setupId) {
    throw conflict('Only the latest setup’s closing date can change. Posting goes by that one.');
  }
  const outcome = parseOutcome(setup.outcome);
  if (!outcome) throw conflict('This setup’s outcome can’t be read.');
  if (date !== null) {
    if (!isDate(date)) throw badRequest('That isn’t a date.');
    if (date > new Date().toISOString().slice(0, 10)) throw badRequest('A closing date can’t be in the future.');
  }
  if (outcome.closingDate === date) return setupView(setup);
  await prisma.integrationSetup.update({
    where: { setupId },
    data: { outcome: { ...(setup.outcome as Prisma.JsonObject), closingDate: date } },
  });
  await appendEvent(setupId, 'closing_date_changed', { from: outcome.closingDate, to: date }, { actorUserId: userId });
  return setupView(await ownSetup(organizationId, setupId));
}

const BILLS_SHOWN = 50;

/**
 * The closing date the books keep themselves, read live as posting reads it, for the screen
 * after setup. A call of its own: the books take seconds to answer, and nothing else waits on it.
 */
export async function booksClosingDate(organizationId: string, system: SetupSystem) {
  const setup = await finishedSetup(organizationId, system);
  const connection = setup ? await connectorFor(system).connection(organizationId) : null;
  // Signed out or off, the books can't be read, and the screen isn't told which date is in force on a guess.
  const inBooks = setup && postingNow(setup, connection) === 'on' ? await closingDateInBooks(setup) : undefined;
  return { inBooks: inBooks ?? null, read: inBooks !== undefined };
}

/**
 * What posting has done since Go, for the screen after setup: the bills that need someone
 * (refused, or held as maybe in the books already), then the rest, newest first. Rows from
 * before this setup's Go belong to an earlier connection, maybe to other books, and are left out.
 */
export async function postingView(organizationId: string, system: SetupSystem) {
  const since = parseOutcome((await finishedSetup(organizationId, system))?.outcome)?.postingFrom;
  if (!since) return { needYou: [], posted: [], postedCount: 0 };
  return billsSince(organizationId, system, new Date(since));
}

async function billsSince(organizationId: string, system: SetupSystem, since: Date) {
  const where = { organizationId, provider: system, createdAt: { gte: since } };
  const stuck: Prisma.AccountingSyncWhereInput = { ...where, externalBillId: null, status: { in: ['error', 'held'] } };
  const rest: Prisma.AccountingSyncWhereInput = { ...where, OR: [{ externalBillId: { not: null } }, { status: { notIn: ['error', 'held'] } }] };
  const select = {
    status: true, externalBillId: true, error: true, attempts: true, syncedAt: true, updatedAt: true, metadataJson: true,
    paymentOrder: {
      select: {
        paymentOrderId: true, amountRaw: true, invoiceNumber: true,
        counterparty: { select: { displayName: true } }, counterpartyWallet: { select: { label: true } },
      },
    },
  } as const;
  const [needYou, posted, postedCount] = await Promise.all([
    prisma.accountingSync.findMany({ where: stuck, orderBy: { updatedAt: 'desc' }, take: BILLS_SHOWN, select }),
    // Still posting first (no syncedAt sorts first descending), then the latest posted.
    prisma.accountingSync.findMany({ where: rest, orderBy: [{ syncedAt: 'desc' }, { updatedAt: 'desc' }], take: BILLS_SHOWN, select }),
    prisma.accountingSync.count({ where: rest }),
  ]);
  const row = (r: (typeof posted)[number]) => ({
    paymentOrderId: r.paymentOrder.paymentOrderId,
    vendor: r.paymentOrder.counterparty?.displayName ?? r.paymentOrder.counterpartyWallet.label,
    invoiceNumber: r.paymentOrder.invoiceNumber,
    amountRaw: r.paymentOrder.amountRaw.toString(),
    ...postingOf(r),
  });
  return { needYou: needYou.map(row), posted: posted.map(row), postedCount };
}

async function setupView(setup: IntegrationSetup) {
  const connector = connectorFor(setup.system);
  const done = setup.status === 'done';
  const [messages, calls, conditions, retry, connection, onCards] = await Promise.all([
    prisma.integrationSetupMessage.findMany({
      where: { setupId: setup.setupId },
      orderBy: { createdAt: 'asc' },
      include: { authorUser: { select: { userId: true, displayName: true, avatarUrl: true } } },
    }),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, orderBy: { createdAt: 'asc' } }),
    doneConditions(setup),
    retrying(setup),
    done ? connector.connection(setup.organizationId) : Promise.resolve(null),
    cardAnswers(setup.setupId),
  ]);
  const posting = done ? postingNow(setup, connection) : null;
  const questions = new Map(calls.map((c) => [c.key, c.question]));
  const answering = (messageId: string) => {
    const key = onCards.get(messageId);
    const question = key ? questions.get(key) : undefined;
    return key && question ? { key, question } : null;
  };
  return {
    setupId: setup.setupId,
    system: setup.system,
    status: setup.status,
    stopReason: setup.stopReason,
    running: messages.some((m) => m.status === 'running'),
    retrying: retry,
    company: { name: setup.companyName, confirmedAt: setup.companyConfirmedAt?.toISOString() ?? null },
    study: { status: setup.studyStatus, steps: setup.studySteps, error: setup.studyError },
    calls: calls.map((c) => ({
      key: c.key,
      kind: c.kind,
      required: c.required,
      status: c.status,
      question: c.question,
      recommendation: c.recommendation,
      why: c.why,
      refs: c.refs,
      answer: c.answer,
    })),
    canGo: setup.status !== 'done' && readyForGo(conditions),
    stillNeeded: setup.status === 'done' ? [] : stillMissing(conditions),
    // The same, by key, for the screen to say in the person's words: stillNeeded is in the model's.
    goConditions: setup.status === 'done' ? [] : conditions.map((c) => ({ key: c.key, done: c.done })),
    // For a finished setup only: whether its yes still holds, and the sign-in that picks it up again.
    posting,
    signInAgain: posting === 'signed_out' ? connector.signInPath(setup.organizationId) : null,
    // For a finished setup, the screen after it: who turned posting on, and what Decimal follows since.
    finished: done ? await finishedView(setup) : null,
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      status: m.status,
      // Who wrote a person's message: more than one admin can be in a setup.
      author: m.authorUser ? { userId: m.authorUser.userId, name: m.authorUser.displayName, avatarUrl: m.authorUser.avatarUrl } : null,
      // Written on a question's card: which question it answers.
      answering: answering(m.messageId),
      text: m.text,
      thoughts: m.thoughts,
      claims: m.claims,
      actions: m.actions,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
