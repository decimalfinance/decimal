// What the model can do in a setup: read broadly, talk to the person, and write to
// the setup's own record. Nothing here can write to the books, and nothing here can
// turn posting on. Each tool checks what it needs itself, so the order that has to
// hold (sign-in before reading, a person's word before an answer, Go last) holds
// however the model behaves.

import type { IntegrationSetup } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../infra/prisma.js';
import type { AgentTool } from '../../exceptions/agent.js';
import { BooksReadError } from '../books.js';
import { connectorFor } from '../connectors.js';
import {
  checkFilters, isDate, lookUp, RECORD_KINDS, RECORD_SORTS, refOf, SUMMARY_GROUPS, summarize, type CopyScope, type RecordFilters, type RecordSort,
} from '../copy.js';
import { companyProblems } from './findings.js';
import { doneConditions, readyForGo, stillMissing } from './gates.js';
import { appendEvent } from './record.js';
import { MAX_STUDY_ATTEMPTS, type StudyFindings } from './study.js';

/** "About seven at most." The rest waits until a bill raises it. */
const MAX_CALLS = 7;
const MAX_OPEN_CALLS = 3;

export type SetupAction =
  | { kind: 'sign_in'; system: string; path: string }
  | { kind: 'go'; companyName: string | null; path: string };

export type Thought = { text: string; detail?: string | null };

export type TurnContext = {
  setupId: string;
  /** The person's message this turn is answering, if one is. */
  speaker: { userId: string | null; messageId: string } | null;
  /** Refs a tool returned this turn. A claim can only cite these. */
  seen: Set<string>;
  /** What this turn's answer will carry. Built here, never by the model. */
  actions: SetupAction[];
  onThought(thought: Thought): Promise<void>;
  startStudy(): void;
};

function parsed<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
}

/** Failures keep their name, so the model knows sign-in lost from "there are none". */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BooksReadError) throw new Error(`${error.kind}: ${error.message}`);
    throw error;
  }
}

const load = (setupId: string) => prisma.integrationSetup.findUniqueOrThrow({ where: { setupId } });

const scopeOf = (setup: IntegrationSetup): CopyScope => {
  if (!setup.companyId) throw new Error('No company has been confirmed yet.');
  return { organizationId: setup.organizationId, system: setup.system, companyId: setup.companyId };
};

/** The copy is only worth asking once a study has filled it. */
function assertStudied(setup: IntegrationSetup) {
  if (setup.studyStatus === 'running') throw new Error('The study is still reading. Its results arrive by themselves when it finishes.');
  if (setup.studyStatus !== 'finished') throw new Error('There is no study to look at yet. It needs a confirmed company, then start_study.');
}

const homeCurrency = (setup: IntegrationSetup) => (setup.findings as StudyFindings | null)?.company?.homeCurrency ?? 'USD';

const filterProperties = {
  vendorId: { type: 'string', description: 'Bills or expenses from this vendor.' },
  categoryId: { type: 'string', description: 'Bills or expenses with a line in this category.' },
  text: { type: 'string', description: 'Words in the name, number, note or line descriptions.' },
  from: { type: 'string', description: 'On or after this date, YYYY-MM-DD.' },
  to: { type: 'string', description: 'On or before this date, YYYY-MM-DD.' },
  minAmount: { type: 'number', description: 'At least this total, in the currency of the books.' },
  maxAmount: { type: 'number', description: 'At most this total, in the currency of the books.' },
};

const FILTERS = z.object({
  vendorId: z.string().max(100).optional(),
  categoryId: z.string().max(100).optional(),
  text: z.string().max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  minAmount: z.number().optional(),
  maxAmount: z.number().optional(),
});

function filtersFrom(input: RecordFilters): RecordFilters {
  const refused = checkFilters(input);
  if (refused) throw new Error(refused);
  return input;
}

const LOOK_UP = FILTERS.extend({
  kind: z.enum(RECORD_KINDS),
  id: z.string().max(100).optional(),
  sort: z.enum(RECORD_SORTS as [string, ...string[]]).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

const SUMMARIZE = FILTERS.extend({ kind: z.enum(['bill', 'expense']), by: z.enum(SUMMARY_GROUPS) });

/** Who may open which call. The two that code insists on are opened by code. */
const CALL_KINDS = ['lookalike_vendors', 'coded_two_ways', 'approved_before_connecting', 'other'] as const;

const OPEN_CALL = z.object({
  key: z.string().regex(/^[a-z0-9_-]{2,60}$/, 'a short slug, like lookalike-delta'),
  kind: z.enum(CALL_KINDS),
  question: z.string().trim().min(5).max(500),
  recommendation: z.string().trim().min(3).max(500),
  why: z.string().trim().min(3).max(500),
  refs: z.array(z.string().max(120)).max(50),
});

const RECORD_ANSWER = z.object({
  key: z.string().max(60),
  answer: z.string().trim().min(1).max(1000),
  value: z.record(z.string(), z.unknown()).nullish(),
});

/**
 * The part of an answer fixed code will use later, checked against what was asked.
 * A reply the model can't turn into this is refused, and it has to ask again.
 */
function answerValue(call: { kind: string; refs: unknown }, value: Record<string, unknown> | null | undefined, findings: StudyFindings | null): Record<string, unknown> | null {
  const refs = Array.isArray(call.refs) ? (call.refs as string[]) : [];
  if (call.kind === 'closing_date') {
    const date = value?.date;
    if (date === null) return { date: null };
    if (typeof date !== 'string' || !isDate(date)) {
      throw new Error('A closing date needs value.date as YYYY-MM-DD, or null if the books have never been closed.');
    }
    if (date > new Date().toISOString().slice(0, 10)) throw new Error('A closing date cannot be in the future. Check it with the person.');
    return { date };
  }
  if (call.kind === 'lookalike_vendors') {
    const useVendorId = value?.useVendorId;
    if (useVendorId === null) return { useVendorId: null };
    if (typeof useVendorId !== 'string' || !refs.includes(refOf('vendor', useVendorId))) {
      throw new Error('value.useVendorId must be one of the vendors in this call, or null to keep them apart.');
    }
    return { useVendorId, vendorIds: refs.filter((r) => r.startsWith('vendor:')).map((r) => r.slice('vendor:'.length)) };
  }
  if (call.kind === 'coded_two_ways') {
    const { vendorId, line, categoryId } = value ?? {};
    const entry = findings?.codedTwoWays.find((c) => c.vendorId === vendorId && c.line === (line ?? null));
    if (!entry) throw new Error('value.vendorId and value.line must match one entry in codedTwoWays.');
    if (categoryId === null) return { vendorId, line: entry.line, categoryId: null };
    if (!entry.accounts.some((a) => a.id === categoryId)) throw new Error('value.categoryId must be one of the categories this line has used, or null to ask each time.');
    return { vendorId, line: entry.line, categoryId };
  }
  return null;
}

/** Findings as the model sees them: everything it might cite carries the ref to cite it by. */
function findingsWithRefs(findings: StudyFindings, seen: Set<string>) {
  const ref = (kind: Parameters<typeof refOf>[0], id: string) => {
    const r = refOf(kind, id);
    seen.add(r);
    return r;
  };
  const decimalRef = (id: string) => {
    const r = `decimal-bill:${id}`;
    seen.add(r);
    return r;
  };
  return {
    ...findings,
    accountsBillsUse: findings.accountsBillsUse.map((a) => ({ ...a, ref: ref('category', a.id) })),
    busiestVendors: findings.busiestVendors.map((v) => ({ ...v, ref: ref('vendor', v.id) })),
    lookalikeVendors: findings.lookalikeVendors.map((g) => ({ ...g, vendors: g.vendors.map((v) => ({ ...v, ref: ref('vendor', v.id) })) })),
    codedTwoWays: findings.codedTwoWays.map((c) => ({
      ...c,
      ref: ref('vendor', c.vendorId),
      accounts: c.accounts.map((a) => ({ ...a, ref: ref('category', a.id) })),
    })),
    learned: {
      ...findings.learned,
      sample: findings.learned.sample.map((s) => ({ ...s, refs: [ref('vendor', s.vendorId), ref('category', s.categoryId)] })),
    },
    cantPost: findings.cantPost.map((c) => ({ ...c, sampleRefs: c.sampleBillIds.map((id) => ref('bill', id)) })),
    decimal: {
      ...findings.decimal,
      approvedBeforeConnecting: {
        ...findings.decimal.approvedBeforeConnecting,
        sampleRefs: findings.decimal.approvedBeforeConnecting.sampleBillIds.map(decimalRef),
      },
    },
  };
}

/** Of these refs, the ones that really are records: seen this turn, or in this company's copy. */
async function realRefs(scope: CopyScope, refs: string[], seen: Set<string>): Promise<string[]> {
  const real: string[] = [];
  for (const candidate of new Set(refs)) {
    if (seen.has(candidate)) {
      real.push(candidate);
      continue;
    }
    const [kind, ...rest] = candidate.split(':');
    const id = rest.join(':');
    if (!id || !(RECORD_KINDS as readonly string[]).includes(kind ?? '')) continue;
    const found = await prisma.booksRecord.findUnique({
      where: { organizationId_system_companyId_kind_recordId: { ...scope, kind: kind!, recordId: id } },
      select: { recordId: true },
    });
    if (found) real.push(candidate);
  }
  return real;
}

export function setupTools(ctx: TurnContext): AgentTool[] {
  return [
    {
      name: 'read_company',
      description: 'Read the signed-in company\'s settings from the live system: name, plan, country, currency, what it tracks. Says what stops it working with Decimal.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const setup = await load(ctx.setupId);
        const connector = connectorFor(setup.system);
        const reader = await connector.reader(setup.organizationId);
        if (!reader) throw new Error('Nobody is signed in. Offer sign-in first.');
        await ctx.onThought({ text: 'Reading the company\'s settings' });
        const company = await reading(() => reader.company());
        const problems = companyProblems(company);
        return { company, problems, canWork: !problems.some((p) => p.blocking) };
      },
    },
    {
      name: 'offer_sign_in',
      description: 'Put a sign-in button under your message. Only the person can sign in, on the system\'s own site. Use changeCompany when they signed in to the wrong company.',
      parameters: { type: 'object', properties: { changeCompany: { type: 'boolean' } } },
      run: async (args) => {
        const { changeCompany } = parsed(z.object({ changeCompany: z.boolean().optional() }), args);
        const setup = await load(ctx.setupId);
        const connector = connectorFor(setup.system);
        const connection = await connector.connection(setup.organizationId);
        if (connection?.status === 'connected' && !changeCompany) {
          return { alreadySignedIn: true, note: 'They are signed in. read_company says to which company.' };
        }
        if (!ctx.actions.some((a) => a.kind === 'sign_in')) {
          ctx.actions.push({ kind: 'sign_in', system: setup.system, path: connector.signInPath(setup.organizationId) });
        }
        return { offered: true, note: 'The button appears under your message. You hear when the sign-in comes back.' };
      },
    },
    {
      name: 'confirm_company',
      description: 'Record that the person said this is the right company. Only when they have just said so in their own words.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        if (!ctx.speaker) throw new Error('The person has said nothing this turn, so they have not confirmed anything. Ask them.');
        const setup = await load(ctx.setupId);
        const reader = await connectorFor(setup.system).reader(setup.organizationId);
        if (!reader) throw new Error('Nobody is signed in. Offer sign-in first.');
        const company = await reading(() => reader.company());
        const blocking = companyProblems(company).filter((p) => p.blocking);
        if (blocking.length > 0) throw new Error(`This company cannot work with Decimal: ${blocking.map((p) => p.detail).join(' ')}`);
        await prisma.integrationSetup.update({
          where: { setupId: ctx.setupId },
          data: { companyId: company.id, companyName: company.name, companyConfirmedAt: new Date(), companyConfirmedByUserId: ctx.speaker.userId },
        });
        await appendEvent(ctx.setupId, 'company_confirmed', { companyId: company.id, companyName: company.name, messageId: ctx.speaker.messageId }, { actorUserId: ctx.speaker.userId });
        return { confirmed: company.name, next: 'start_study' };
      },
    },
    {
      name: 'start_study',
      description: 'Start reading the company\'s categories, vendors, bills and expenses (24 months) into a copy, and work out the findings. Runs by itself; you hear when it finishes. Use again to read it again after they changed something in their books.',
      parameters: { type: 'object', properties: { again: { type: 'boolean' } } },
      run: async (args) => {
        const { again } = parsed(z.object({ again: z.boolean().optional() }), args);
        const setup = await load(ctx.setupId);
        if (!setup.companyConfirmedAt) throw new Error('The person has to confirm the company first.');
        if (setup.studyStatus === 'running') return { status: 'running', note: 'It is already reading.' };
        if (setup.studyStatus === 'finished' && !again) return { status: 'finished', note: 'Already finished. get_findings has the results.' };
        if (setup.studyAttempts >= MAX_STUDY_ATTEMPTS) {
          throw new Error(`It has failed ${setup.studyAttempts} times since the last sign-in, so stop trying. Tell the person what is in the way. Signing in again starts the count again.`);
        }
        const { count } = await prisma.integrationSetup.updateMany({
          where: { setupId: ctx.setupId, OR: [{ studyStatus: null }, { studyStatus: { in: ['failed', 'finished'] } }] },
          data: { studyStatus: 'running', studyAttempts: { increment: 1 }, studySteps: [], studyLeaseUntil: null },
        });
        if (count === 0) return { status: 'running', note: 'It is already reading.' };
        await appendEvent(ctx.setupId, 'study_started', { attempt: setup.studyAttempts + 1 });
        ctx.startStudy();
        return { status: 'running', note: 'Tell the person they can leave. You hear when it finishes.' };
      },
    },
    {
      name: 'get_findings',
      description: 'What the study worked out: counts, totals, busiest vendors, categories in use, look-alike vendors, lines coded two ways, what cannot post yet, reads that came back short, bills approved before connecting. Made by code, so quote it rather than recount it.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        await ctx.onThought({ text: 'Going through what the study found' });
        return findingsWithRefs(setup.findings as StudyFindings, ctx.seen);
      },
    },
    {
      name: 'look_up',
      description: 'Read the stored copy: one record by id, or a list by filters. Use it to chase whatever looks odd. Every record has a ref you can cite.',
      parameters: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: RECORD_KINDS },
          id: { type: 'string', description: 'One record, in full.' },
          ...filterProperties,
          sort: { type: 'string', enum: RECORD_SORTS },
          limit: { type: 'number', description: 'Up to 50. Default 20.' },
          offset: { type: 'number' },
        },
      },
      run: async (args) => {
        const { kind, sort, limit, offset, ...filters } = parsed(LOOK_UP, args);
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        await ctx.onThought({ text: `Looking through the ${kind === 'category' ? 'categories' : `${kind}s`}` });
        const found = await lookUp(scopeOf(setup), kind, filtersFrom(filters), {
          sort: sort as RecordSort | undefined, limit, offset, homeCurrency: homeCurrency(setup),
        });
        for (const row of found.rows) ctx.seen.add(String(row.ref));
        return found;
      },
    },
    {
      name: 'summarize',
      description: 'Count and add up bills or expenses by vendor, category or month, with the same filters as look_up. Use it instead of adding anything up yourself.',
      parameters: {
        type: 'object',
        required: ['kind', 'by'],
        properties: { kind: { type: 'string', enum: ['bill', 'expense'] }, by: { type: 'string', enum: SUMMARY_GROUPS }, ...filterProperties },
      },
      run: async (args) => {
        const { kind, by, ...filters } = parsed(SUMMARIZE, args);
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        await ctx.onThought({ text: `Adding up ${kind}s by ${by}` });
        const summary = await summarize(scopeOf(setup), kind, by, filtersFrom(filters), homeCurrency(setup));
        if (by !== 'month') {
          const refKind = by === 'vendor' ? 'vendor' : 'category';
          for (const group of summary.groups) if (group.key) ctx.seen.add(refOf(refKind, group.key));
        }
        return summary;
      },
    },
    {
      name: 'open_call',
      description: 'Record something only the person can decide, with your recommendation, why, and the records behind it. Then ask it in your message. The closing date and who approves are opened for you.',
      parameters: {
        type: 'object',
        required: ['key', 'kind', 'question', 'recommendation', 'why', 'refs'],
        properties: {
          key: { type: 'string', description: 'A short slug. Using it again rewords the same call.' },
          kind: { type: 'string', enum: CALL_KINDS },
          question: { type: 'string' },
          recommendation: { type: 'string' },
          why: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' }, description: 'Refs of the records behind it, from your tools.' },
        },
      },
      run: async (args) => {
        const input = parsed(OPEN_CALL, args);
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        const refs = await realRefs(scopeOf(setup), input.refs, ctx.seen);
        if (refs.length === 0) throw new Error('A call has to cite records your tools returned, and none of these are.');
        const existing = await prisma.integrationSetupCall.findUnique({ where: { setupId_key: { setupId: ctx.setupId, key: input.key } } });
        if (existing?.status === 'answered') return { alreadyAnswered: existing.answer };
        if (existing?.required) throw new Error('This call was opened for you. Just ask it.');
        if (!existing) {
          const calls = await prisma.integrationSetupCall.findMany({ where: { setupId: ctx.setupId }, select: { status: true } });
          if (calls.length >= MAX_CALLS) throw new Error(`That is ${MAX_CALLS} calls, the most one setup asks. Anything smaller waits until a bill raises it.`);
          if (calls.filter((c) => c.status === 'open').length >= MAX_OPEN_CALLS) {
            throw new Error(`${MAX_OPEN_CALLS} calls are already waiting on the person. Get those answered first.`);
          }
        }
        const { key, ...words } = { ...input, refs };
        await prisma.integrationSetupCall.upsert({
          where: { setupId_key: { setupId: ctx.setupId, key } },
          create: { setupId: ctx.setupId, key, ...words },
          update: words,
        });
        await appendEvent(ctx.setupId, 'call_opened', { key, kind: input.kind, refs });
        return { opened: key };
      },
    },
    {
      name: 'record_answer',
      description: 'Save what the person decided on a call. Only when they have just said so. value holds the usable part: closing_date {date: "YYYY-MM-DD" or null}; lookalike_vendors {useVendorId, or null to keep them apart}; coded_two_ways {vendorId, line, categoryId, or null to ask each time}. They can change their mind: record it again.',
      parameters: {
        type: 'object',
        required: ['key', 'answer'],
        properties: {
          key: { type: 'string' },
          answer: { type: 'string', description: 'What they decided, in a few plain words.' },
          value: { type: 'object' },
        },
      },
      run: async (args) => {
        if (!ctx.speaker) throw new Error('The person has said nothing this turn, so there is nothing to record.');
        const input = parsed(RECORD_ANSWER, args);
        const setup = await load(ctx.setupId);
        const call = await prisma.integrationSetupCall.findUnique({ where: { setupId_key: { setupId: ctx.setupId, key: input.key } } });
        if (!call) throw new Error(`There is no call called ${input.key}.`);
        const value = answerValue(call, input.value, setup.findings as StudyFindings | null);
        await prisma.integrationSetupCall.update({
          where: { setupId_key: { setupId: ctx.setupId, key: input.key } },
          data: {
            status: 'answered',
            answer: input.answer,
            value: value === null ? undefined : (value as object),
            answerMessageId: ctx.speaker.messageId,
            answeredByUserId: ctx.speaker.userId,
            answeredAt: new Date(),
          },
        });
        await appendEvent(ctx.setupId, 'call_answered', { key: input.key, answer: input.answer, value, messageId: ctx.speaker.messageId }, { actorUserId: ctx.speaker.userId });
        return { recorded: input.key };
      },
    },
    {
      name: 'offer_go',
      description: 'Ask to put the Go button under your message. Code decides: if anything is missing you hear what. Only the person pressing it turns posting on.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const setup = await load(ctx.setupId);
        const conditions = await doneConditions(setup);
        if (!readyForGo(conditions)) return { offered: false, stillNeeded: stillMissing(conditions) };
        if (!ctx.actions.some((a) => a.kind === 'go')) {
          ctx.actions.push({
            kind: 'go',
            companyName: setup.companyName,
            path: `/organizations/${setup.organizationId}/integrations/setups/${setup.setupId}/go`,
          });
        }
        return { offered: true, note: 'The button appears under your message. Say what pressing it does.' };
      },
    },
  ];
}
