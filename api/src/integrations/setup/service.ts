// What the routes do with a setup: start one, take a message, hear the sign-in come
// back, take the person's yes, show it.

import { Prisma, type IntegrationSetup } from '@prisma/client';
import { ApiError, conflict, notFound } from '../../infra/api-errors.js';
import { prisma } from '../../infra/prisma.js';
import { connectorFor } from '../connectors.js';
import { deleteCopy, lookUp, type RecordKind } from '../copy.js';
import { doneConditions, readyForGo, stillMissing } from './gates.js';
import { wake } from './harness.js';
import { playbookFor } from './playbooks.js';
import { appendEvent, liveSetup, type SetupSystem } from './record.js';
import type { StudyFindings } from './study.js';

/** Start a setup, or come back to the one under way. Only one runs per organisation and system. */
export async function startSetup(organizationId: string, userId: string, system: SetupSystem) {
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
 */
export async function postMessage(organizationId: string, userId: string, setupId: string, text: string) {
  const setup = await ownSetup(organizationId, setupId);
  if (setup.status === 'done') throw conflict('This setup is finished.');
  if (setup.status === 'stopped' && setup.stopReason !== 'failures') {
    throw conflict('This setup has reached its limit. Someone at Decimal needs to raise it.');
  }
  const message = await prisma.integrationSetupMessage.create({ data: { setupId, role: 'user', status: 'done', authorUserId: userId, text } });
  await appendEvent(setupId, 'message', { messageId: message.messageId }, { actorUserId: userId, wakes: true });
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
async function outcomeOf(setup: IntegrationSetup, postingFrom: Date) {
  const calls = await prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId, status: 'answered' } });
  const valueOf = <T>(kind: string) => calls.filter((c) => c.kind === kind && c.value !== null).map((c) => c.value as T);
  const findings = setup.findings as StudyFindings | null;
  return {
    companyId: setup.companyId,
    postingFrom: postingFrom.toISOString(),
    closingDate: valueOf<{ date: string | null }>('closing_date')[0]?.date ?? null,
    vendorLinks: valueOf<{ useVendorId: string | null; vendorIds: string[] }>('lookalike_vendors').filter((v) => v.useVendorId),
    lineChoices: valueOf<{ vendorId: string; line: string | null; categoryId: string | null }>('coded_two_ways'),
    categoriesInUse: findings?.accountsBillsUse.map((a) => a.id) ?? [],
    cantPost: findings?.cantPost.map((c) => c.kind) ?? [],
  };
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
  const postingFrom = await connectorFor(setup.system).enablePosting(organizationId, userId);
  if (!postingFrom) throw new ApiError(409, 'not_connected', 'The connection is no longer live.');
  const outcome = await outcomeOf(setup, postingFrom);
  const label = playbookFor(setup.system).label;
  const done = await prisma.integrationSetup.update({
    where: { setupId },
    data: { status: 'done', stopReason: null, outcome: outcome as object },
  });
  await prisma.integrationSetupMessage.create({
    data: {
      setupId,
      role: 'assistant',
      status: 'done',
      text: `Done. Bills approved from now on post to ${label} as unpaid bills. Nothing already in ${label} changed.`,
    },
  });
  await appendEvent(setupId, 'go', { companyId: setup.companyId, companyName: setup.companyName, postingFrom: postingFrom.toISOString() }, { actorUserId: userId });
  return setupView(done);
}

export async function getSetup(organizationId: string, setupId: string) {
  return setupView(await ownSetup(organizationId, setupId));
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

async function setupView(setup: IntegrationSetup) {
  const [messages, calls, conditions] = await Promise.all([
    prisma.integrationSetupMessage.findMany({ where: { setupId: setup.setupId }, orderBy: { createdAt: 'asc' } }),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, orderBy: { createdAt: 'asc' } }),
    doneConditions(setup),
  ]);
  return {
    setupId: setup.setupId,
    system: setup.system,
    status: setup.status,
    stopReason: setup.stopReason,
    running: messages.some((m) => m.status === 'running'),
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
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      status: m.status,
      text: m.text,
      thoughts: m.thoughts,
      claims: m.claims,
      actions: m.actions,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
