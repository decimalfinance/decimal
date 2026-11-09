// What the model can do in a setup: read broadly, talk to the person, and write to
// the setup's own record. Nothing here can write to the books, and nothing here can
// turn posting on. Each tool checks what it needs itself, so the order that has to
// hold (sign-in before reading, a person's word before an answer, Go last) holds
// however the model behaves.

import type { IntegrationSetup } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../infra/prisma.js';
import { lineKey } from '../../accounting/line-words.js';
import type { AgentTool } from '../../exceptions/agent.js';
import { BooksReadError } from '../books.js';
import { connectorFor } from '../connectors.js';
import {
  checkFilters, isDate, lookUp, RECORD_KINDS, RECORD_SORTS, refOf, SUMMARY_GROUPS, summarize, type CopyScope, type RecordFilters, type RecordSort,
} from '../copy.js';
import { companyProblems, linesToDecide } from './findings.js';
import { doneConditions, notRaised, wordsSaid, readyForGo, stillMissing } from './gates.js';
import { playbookFor, type Playbook } from './playbooks.js';
import { appendEvent, cardAnswers } from './record.js';
import type { StudyFindings } from './study.js';

/** "About seven at most." The rest waits until a bill raises it. */
const MAX_CALLS = 7;
/** How many it asks in one message. The rest wait their turn in the record, where they can't be forgotten. */
export const ASK_AT_ONCE = 2;

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
  /** What was saved this turn on vendors and lines, in code's words, by call. It goes above the message. */
  saved: Map<string, string[]>;
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

/** The copy is only worth asking once reading has filled it. */
function assertStudied(setup: IntegrationSetup) {
  if (setup.studyStatus === 'running') throw new Error('Their books are still being read. You hear when it finishes.');
  if (setup.studyStatus !== 'finished') throw new Error('Nothing has been read yet. It needs a confirmed company, then start_reading.');
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
const CALL_KINDS = ['lookalike_vendors', 'coded_two_ways', 'other'] as const;

/** What has to have come up, in anything either of them said, before an answer to these can be real. */
const CAME_UP: Record<string, RegExp> = { closing_date: /\bclos(e|ed|es|ing)\b/i, who_approves: /\bapprov/i };

/** A closing date decides which bills can't post, so it's one they said or agreed to. Picking one for them isn't an answer. */
const GAVE_OR_AGREED = /\d|\b(yes|yep|yeah|right|correct|agreed?|confirm(ed)?|ok(ay)?|fine|exactly|go ahead)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/** What takes the same kind of answer is one question: the person answers it in one go, and a setup stays about seven questions. */
const ONE_CALL_PER_KIND: readonly string[] = ['lookalike_vendors', 'coded_two_ways'];

const OPEN_CALL = z.object({
  key: z.string().regex(/^[a-z0-9_-]{2,60}$/, 'a short slug, like lookalike-delta'),
  kind: z.enum(CALL_KINDS),
  question: z.string().trim().min(5).max(1500),
  recommendation: z.string().trim().min(3).max(1000, 'Keep the recommendation to a sentence or two: code lists the records under your question.'),
  why: z.string().trim().min(3).max(1000),
  refs: z.array(z.string().max(120)).max(100),
});

const RECORD_ANSWER = z.object({
  key: z.string().max(60),
  answer: z.string().trim().min(1).max(1000),
  value: z.record(z.string(), z.unknown()).nullish(),
});

const NAME = z.string().trim().min(1).max(300);
const SAME = z.array(z.object({ keep: NAME, with: z.array(NAME).min(1) }));
const CHOICES = z.array(z.object({ vendor: NAME, line: z.string().max(500).nullable(), category: NAME.nullable() })).min(1);

type VendorLink = { useVendorId: string; vendorIds: string[] };
type LineChoice = { vendorId: string; line: string | null; categoryId: string | null };

const idOf = (kind: 'vendor' | 'category', id: string) => (id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id);
const looseName = (name: string) => name.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Answers come by name, because that's how a person says them and a model copies them. Turning a name into a
 * record has to be exact, so code does it: the exact name, then the same but for case and spacing, then an id.
 * "Sterling Office Supply" and "Sterling Office Supply, Inc." are two vendors, so nothing looser than that.
 */
async function vendorsByName(setup: IntegrationSetup): Promise<(text: string) => { id: string; name: string }> {
  const rows = (await prisma.booksRecord.findMany({ where: { ...scopeOf(setup), kind: 'vendor' }, select: { recordId: true, name: true } }))
    .map((r) => ({ id: r.recordId, name: r.name ?? r.recordId }));
  return (text) => {
    const exact = rows.filter((r) => r.name === text);
    const loose = exact.length > 0 ? exact : rows.filter((r) => looseName(r.name) === looseName(text));
    const found = loose.length > 0 ? loose : rows.filter((r) => r.id === idOf('vendor', text));
    if (found.length === 1) return found[0]!;
    throw new Error(found.length > 1 ? `More than one vendor is called "${text}". Copy the name exactly as the call shows it.` : `No vendor is called "${text}". Copy the name exactly as the call shows it.`);
  };
}

/** An answer as names, for the model to say back. A wrong id shows up here, where the person can catch it. */
export async function inWords(call: { kind: string; refs: unknown }, value: unknown, setup: IntegrationSetup): Promise<string[] | undefined> {
  if (call.kind === 'who_approves') return ['Recorded. What they chose is theirs to do before their first bill, and it doesn\'t hold up Go.'];
  if (call.kind === 'other') return ['Kept on the record, and that is all. It changes nothing in their books or in how a bill posts, so don\'t say it will.'];
  const saved = (value ?? {}) as { date?: string | null; links?: VendorLink[]; choices?: LineChoice[] };
  if (call.kind === 'closing_date') return [saved.date ? `Closed through ${saved.date}.` : 'Their books have never been closed.'];
  if (saved.links) {
    if (saved.links.length === 0) return ['They all stay separate vendors.'];
    const rows = await prisma.booksRecord.findMany({
      where: { ...scopeOf(setup), kind: 'vendor', recordId: { in: saved.links.flatMap((l) => l.vendorIds) } },
      select: { recordId: true, name: true },
    });
    const name = (id: string) => rows.find((r) => r.recordId === id)?.name ?? id;
    return [
      ...saved.links.map((l) => {
        const others = l.vendorIds.filter((id) => id !== l.useVendorId).map(name);
        return `Bills for ${others.slice(0, -1).join(', ')}${others.length > 1 ? ' and ' : ''}${others.at(-1)} go to ${name(l.useVendorId).replace(/\.$/, '')}.`;
      }),
      'Every other vendor stays as it is.',
    ];
  }
  if (saved.choices) {
    const findings = setup.findings as StudyFindings | null;
    const lines = linesToDecide(findings);
    const cited = Array.isArray(call.refs) ? (call.refs as string[]) : [];
    const unsettled = (findings?.codedTwoWays ?? []).filter((t) => cited.includes(`vendor:${t.vendorId}`) && !saved.choices!.some((c) => c.vendorId === t.vendorId && c.line === t.line));
    return [
      ...saved.choices.map((c) => {
        const entry = lines.find((t) => t.vendorId === c.vendorId && t.line === c.line);
        const what = `"${entry?.example ?? c.line}" from ${entry?.vendorName ?? c.vendorId}`;
        return c.categoryId === null ? `${what}: a person picks the category each time.` : `${what} goes to ${entry?.accounts.find((a) => a.id === c.categoryId)?.name ?? c.categoryId}.`;
      }),
      ...unsettled.map((t) => `Nothing was said on "${t.example ?? t.line}" from ${t.vendorName}, so a person picks the category each time.`),
    ];
  }
  return undefined;
}

/**
 * What a question asks about, written by code under the model's words: the exact names, how much each is used,
 * and what they share. Asked to write this itself, a model asks "which of your vendors are one business?" and names none.
 */
export async function listFor(kind: unknown, setupId: string): Promise<string> {
  if (kind !== 'lookalike_vendors' && kind !== 'coded_two_ways') return '';
  const [setup, call] = await Promise.all([
    prisma.integrationSetup.findUniqueOrThrow({ where: { setupId }, select: { findings: true } }),
    prisma.integrationSetupCall.findFirst({ where: { setupId, kind }, select: { refs: true, value: true } }),
  ]);
  const findings = setup.findings as StudyFindings | null;
  const cited = new Set(Array.isArray(call?.refs) ? (call.refs as string[]) : []);
  const isCited = (id: string) => cited.size === 0 || cited.has(`vendor:${id}`);
  // What they've settled isn't asked again, unless that's all there is: asked for then, it's because they never saw it.
  const settled = (call?.value ?? {}) as { links?: Array<{ vendorIds: string[] }>; choices?: Array<{ vendorId: string; line: string | null }> };
  const stillOpen = <T>(rows: T[], isSettled: (row: T) => boolean) => (rows.some((r) => !isSettled(r)) ? rows.filter((r) => !isSettled(r)) : rows);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  if (kind === 'coded_two_ways') {
    return stillOpen((findings?.codedTwoWays ?? []).filter((c) => isCited(c.vendorId)), (c) => Boolean(settled.choices?.some((s) => s.vendorId === c.vendorId && s.line === c.line)))
      .map((c) => `- ${c.vendorName}, ${c.example ? `"${c.example}"${c.alsoWritten?.length ? ` (also "${c.alsoWritten.join('", "')}")` : ''}` : 'its lines'}: ${c.accounts.map((a) => `${a.name} (${count(a.lines, 'line')})`).join(' or ')}`)
      .join('\n');
  }
  const askedOf = (g: { vendors: Array<{ id: string }> }) => g.vendors.filter((v) => isCited(v.id));
  return stillOpen((findings?.lookalikeVendors ?? []).filter((g) => askedOf(g).length >= 2), (g) => Boolean(settled.links?.some((l) => askedOf(g).every((v) => l.vendorIds.includes(v.id)))))
    .map((g) => {
      const vendors = g.vendors.map((v) => {
        const used = [...(v.bills > 0 || v.expenses === 0 ? [count(v.bills, 'bill')] : []), ...(v.expenses > 0 ? [count(v.expenses, 'expense')] : []), ...(v.active ? [] : ['inactive'])];
        return `${v.name} (${used.join(', ')})`;
      });
      const about = [...(g.shared.length > 0 ? [`same ${g.shared.join(', ')}`] : []), ...(g.differentAccounts ? ['different account numbers'] : [])];
      return `- ${vendors.join(', ')}${about.length > 0 ? `: ${about.join('; ')}` : ''}`;
    })
    .join('\n');
}

/** What a bill Decimal posts leaves out that their past bills had, a sentence each. */
export function leftOutLines(findings: StudyFindings | null, playbook: Pick<Playbook, 'label' | 'leftOutWords'>): string[] {
  const { label, leftOutWords: words } = playbook;
  const billsWith = (kind: string) => findings?.leftOut.find((l) => l.kind === kind)?.bills ?? 0;
  const used = [
    [billsWith('item_lines'), words.item_lines],
    [billsWith('classes'), words.classes],
    [billsWith('locations'), words.locations],
    [billsWith('billable_to_customer'), 'were marked billable to a customer'],
  ].filter(([n]) => Number(n) > 0).map(([n, what]) => `${n} ${what}`);
  const other = billsWith('other_currency');
  const lines = [
    ...(used.length > 0 ? [`A bill Decimal posts has Category lines only. Of your past bills, ${used.slice(0, -1).join(', ')}${used.length > 1 ? ' and ' : ''}${used.at(-1)}. You can add those in ${label} once a bill is posted, and none of it stops a bill posting.`] : []),
    ...(other > 0 ? [`${other === 1 ? 'One past bill was' : `${other} past bills were`} in another currency. A bill like that doesn't post, so enter it in ${label} by hand.`] : []),
  ];
  return lines;
}

/**
 * What a posted bill leaves out, in code's words, under the first message once their books are read.
 * Given it to say, the model said "your bills leave out class" in run after run, which is backwards.
 */
export function leftOutInWords(findings: StudyFindings | null, playbook: Pick<Playbook, 'label' | 'leftOutWords'>): string {
  const lines = leftOutLines(findings, playbook);
  return lines.length > 0 ? `Worth knowing:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

const OFFER_GO = z.object({ passedOver: z.array(z.object({ id: z.string(), why: z.string().trim().min(3).max(500) })).max(40).optional() });

/**
 * The part of an answer fixed code will use later, checked against what was asked.
 * A reply the model can't turn into this is refused, and it has to ask again.
 */
async function answerValue(call: { kind: string; value: unknown }, value: Record<string, unknown> | null | undefined, setup: IntegrationSetup): Promise<Record<string, unknown> | null> {
  const findings = setup.findings as StudyFindings | null;
  const before = (call.value ?? {}) as { links?: VendorLink[]; choices?: LineChoice[] };
  if (call.kind === 'closing_date') {
    // Stored as null, which reads like "don't know" and was recorded for it. So the model has to say it outright.
    if (value?.neverClosed === true) return { date: null };
    const date = value?.date;
    if (typeof date !== 'string' || !isDate(date)) {
      throw new Error('A closing date needs value.date as YYYY-MM-DD, or value.neverClosed as true if they said the books have never been closed. If they are not sure, record nothing and leave it open.');
    }
    if (date > new Date().toISOString().slice(0, 10)) throw new Error('A closing date cannot be in the future. Check it with the person.');
    return { date };
  }
  if (call.kind === 'lookalike_vendors') {
    const same = SAME.safeParse(value?.same ?? (value?.apart ? [] : undefined));
    const apartNames = z.array(NAME).safeParse(value?.apart ?? []);
    if (!same.success || !apartNames.success) {
      throw new Error('value.same lists {keep, with: [...]} by name for each group they said is one vendor, and value.apart any vendor to take back out of a group. Vendors nobody names stay separate, so {same: []} is right when they all are.');
    }
    const named = await vendorsByName(setup);
    const used = new Set<string>(apartNames.data.map((text) => named(text).id));
    const links = same.data.map((group) => {
      const keep = named(group.keep);
      const vendorIds = [...new Set([keep.id, ...group.with.map((text) => named(text).id)])];
      if (vendorIds.length < 2) throw new Error(`"${group.keep}" needs another vendor to be one with.`);
      for (const id of vendorIds) {
        if (used.has(id)) throw new Error(`Vendor ${id} is in two groups.`);
        used.add(id);
      }
      return { useVendorId: keep.id, vendorIds };
    });
    // A later answer only changes the vendors it names. What they said about the others stands.
    const kept = (before.links ?? [])
      .map((l) => ({ ...l, vendorIds: l.vendorIds.filter((id) => !used.has(id)) }))
      .filter((l) => l.vendorIds.length >= 2 && l.vendorIds.includes(l.useVendorId));
    return { links: [...kept, ...links] };
  }
  if (call.kind === 'coded_two_ways') {
    const choices = CHOICES.safeParse(value?.choices);
    if (!choices.success) throw new Error('value.choices lists {vendor, line, category} for each line they decided: the vendor by name, the line\'s words, and the category by name, or null for a person to pick each time.');
    const named = await vendorsByName(setup);
    const lines = linesToDecide(findings);
    const said = choices.data.map((choice) => {
      const vendor = named(choice.vendor);
      const ofVendor = lines.filter((l) => l.vendorId === vendor.id);
      const entry = ofVendor.find((l) => l.line === (choice.line === null ? null : lineKey(choice.line) || null));
      if (!entry) {
        throw new Error(`"${choice.line}" from ${vendor.name} isn't a line with a decision to make.${ofVendor.length > 0 ? ` Its lines are: ${ofVendor.map((l) => l.example ?? l.line).join(', ')}.` : ''}`);
      }
      if (choice.category === null) return { vendorId: vendor.id, line: entry.line, categoryId: null };
      const text = looseName(choice.category);
      const category = entry.accounts.filter((a) => looseName(a.name) === text || looseName(a.name.split(':').at(-1)!) === text || a.id === idOf('category', choice.category!));
      if (category.length !== 1) {
        throw new Error(`"${choice.category}" isn't one of the categories this line has used: ${entry.accounts.map((a) => a.name).join(', ')}. Use one of those, or null for a person to pick each time.`);
      }
      return { vendorId: vendor.id, line: entry.line, categoryId: category[0]!.id };
    });
    for (const [i, c] of said.entries()) {
      if (said.slice(0, i).some((o) => o.vendorId === c.vendorId && o.line === c.line && o.categoryId !== c.categoryId)) {
        throw new Error(`"${choices.data[i]!.line}" can't go to two categories. If it depends on something, use category null: a person picks each time.`);
      }
    }
    // The same here: the lines it doesn't name stand as they were.
    return { choices: [...(before.choices ?? []).filter((b) => !said.some((c) => c.vendorId === b.vendorId && c.line === b.line)), ...said] };
  }
  return null;
}

/** A line as it was written. Its key ("laptop plan support") is how code compares lines, and the model quoted it to people. */
const asWritten = <T extends { line: string | null; example: string | null }>({ line, example, ...rest }: T) => ({ ...rest, line: example ?? line });

/** Findings as the model sees them: everything it might cite carries the ref to cite it by. */
function findingsWithRefs({ learnedLines: _forCoding, shortfalls, leftOut, decimal: { approvedBeforeConnecting: approved, ...decimal }, ...findings }: StudyFindings, seen: Set<string>) {
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
      ...asWritten(c),
      ref: ref('vendor', c.vendorId),
      accounts: c.accounts.map((a) => ({ ...a, ref: ref('category', a.id) })),
    })),
    ...(findings.counts.bills + findings.counts.expenses === 0 ? { noHistory: true } : {}),
    ...(findings.counts.bills === 0 && findings.counts.expenses > 0 ? { expensesOnly: true } : {}),
    ...(findings.movedLines.length > 0 ? { movedLines: findings.movedLines.map((m) => ({ ...asWritten(m), refs: [ref('vendor', m.vendorId), ref('category', m.from.id), ref('category', m.to.id)] })) } : {}),
    learned: {
      ...findings.learned,
      sample: findings.learned.sample.map((s) => ({ ...asWritten(s), refs: [ref('vendor', s.vendorId), ref('category', s.categoryId)] })),
    },
    // What isn't there isn't shown, so it doesn't get brought up.
    ...(leftOut.length > 0 ? { leftOut: leftOut.map((c) => ({ ...c, sampleRefs: c.sampleBillIds.map((id) => ref('bill', id)) })) } : {}),
    ...(shortfalls.length > 0 ? { notFullyRead: shortfalls } : {}),
    decimal: {
      ...decimal,
      ...(approved.bills > 0 ? { approvedBeforeConnecting: { ...approved, sampleRefs: approved.sampleBillIds.map(decimalRef) } } : {}),
    },
  };
}

/** Why this call has nothing behind it, if it doesn't. A question with no evidence wastes the person's time. */
function nothingToAsk(kind: string, refs: string[], findings: StudyFindings | null): string | null {
  const vendors = refs.filter((r) => r.startsWith('vendor:')).map((r) => r.slice('vendor:'.length));
  if (kind === 'lookalike_vendors' && vendors.length < 2) return 'A look-alike call cites the vendors that could be confused: at least two.';
  if (kind === 'coded_two_ways' && !linesToDecide(findings).some((c) => vendors.includes(c.vendorId))) {
    return 'Their books show no line coded two ways for this vendor, so there is nothing to ask. Having no calls of your own is normal.';
  }
  return null;
}

/** Of these refs, the ones that really are records: seen this turn, or in this company's copy. */
/** Decimal's own bills that came up. They aren't in the copy, and a later turn can cite them too. */
export const decimalRefs = (findings: unknown): string[] =>
  ((findings as StudyFindings | null)?.decimal.approvedBeforeConnecting.sampleBillIds ?? []).map((id) => `decimal-bill:${id}`);

export async function realRefs(scope: CopyScope, refs: string[], seen: Set<string>): Promise<string[]> {
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
        const problems = companyProblems(company, playbookFor(setup.system).label);
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
        await ctx.onThought({ text: 'Confirming the company' });
        const setup = await load(ctx.setupId);
        const reader = await connectorFor(setup.system).reader(setup.organizationId);
        if (!reader) throw new Error('Nobody is signed in. Offer sign-in first.');
        const company = await reading(() => reader.company());
        const blocking = companyProblems(company, playbookFor(setup.system).label).filter((p) => p.blocking);
        if (blocking.length > 0) throw new Error(`This company cannot work with Decimal: ${blocking.map((p) => p.detail).join(' ')}`);
        await prisma.integrationSetup.update({
          where: { setupId: ctx.setupId },
          data: { companyId: company.id, companyName: company.name, companyConfirmedAt: new Date(), companyConfirmedByUserId: ctx.speaker.userId },
        });
        await appendEvent(ctx.setupId, 'company_confirmed', { companyId: company.id, companyName: company.name, messageId: ctx.speaker.messageId }, { actorUserId: ctx.speaker.userId });
        return { confirmed: company.name, next: 'start_reading' };
      },
    },
    {
      name: 'start_reading',
      description: 'Start reading the company\'s categories, vendors, bills and expenses (24 months) into a copy, and work out the findings. Runs by itself; you hear when it finishes. Use again to read it again after they changed something in their books.',
      parameters: { type: 'object', properties: { again: { type: 'boolean' } } },
      run: async (args) => {
        const { again } = parsed(z.object({ again: z.boolean().optional() }), args);
        const setup = await load(ctx.setupId);
        if (!setup.companyConfirmedAt) throw new Error('The person has to confirm the company first.');
        if (setup.studyStatus === 'running') return { status: 'running', note: 'It is already reading.' };
        if (setup.studyStatus === 'finished' && !again) return { status: 'finished', note: 'Already finished. get_findings has the results.' };
        // Code already tried more than once before it failed. Only a person's word, or a new sign-in, makes another try worth it.
        if (setup.studyStatus === 'failed' && setup.studyAttempts > 0 && !ctx.speaker) {
          throw new Error('It has only just failed, and it already tried more than once by itself. Tell the person what is in the way. It can try again when they ask, or after they sign in again.');
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
      description: 'What reading their books came to: counts, totals, busiest vendors, categories in use, look-alike vendors, lines coded two ways, what a posted bill leaves out, anything not fully read, bills approved before connecting. Made by code, so quote it rather than recount it.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        // A step is shown to the person, so it speaks to them: "their books" read as someone else's.
        await ctx.onThought({ text: 'Going through what I found in your books' });
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
      description: 'Record something only the person can decide, with your recommendation, why, and the records behind it. Open everything you want to ask as soon as you know it: the state keeps it and marks which to ask now. Where the same kind of answer fits several look-alike groups, or several lines, put them in one call, so one reply can settle them: there is one call of each of those kinds, and opening it again adds to it. The closing date and who approves are opened for you.',
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
        const key = typeof args.key === 'string' ? args.key : null;
        // One question per kind, whatever this one calls it. Told to use the other name, the model spent whole turns trying new ones.
        const one = typeof args.kind === 'string' && ONE_CALL_PER_KIND.includes(args.kind) ? await prisma.integrationSetupCall.findFirst({ where: { setupId: ctx.setupId, kind: args.kind } }) : null;
        const existing = one ?? (key ? await prisma.integrationSetupCall.findUnique({ where: { setupId_key: { setupId: ctx.setupId, key } } }) : null);
        const had = Array.isArray(existing?.refs) ? (existing.refs as string[]) : [];
        const given = Array.isArray(args.refs) ? args.refs : [];
        // An answered one opens again only for something new to ask.
        if (existing?.status === 'answered' && (existing.required || given.every((r) => had.includes(r as string)))) return { alreadyAnswered: existing.answer };
        if (existing?.required) return { alreadyOpen: existing.key, note: 'Its words are in the state. Just ask it in your message.' };
        const input = parsed(OPEN_CALL, existing ? { ...args, key: existing.key } : args);
        await ctx.onThought({ text: 'Writing down a question to ask' });
        const setup = await load(ctx.setupId);
        assertStudied(setup);
        const refs = await realRefs(scopeOf(setup), input.refs, new Set([...ctx.seen, ...decimalRefs(setup.findings)]));
        if (refs.length === 0 && had.length === 0) throw new Error('A call has to cite records your tools returned, and none of these are.');
        const cites = [...new Set([...had, ...refs])];
        const empty = nothingToAsk(input.kind, cites, setup.findings as StudyFindings | null);
        if (empty) throw new Error(empty);
        if (!existing) {
          const calls = await prisma.integrationSetupCall.count({ where: { setupId: ctx.setupId } });
          if (calls >= MAX_CALLS) throw new Error(`That is ${MAX_CALLS} calls, the most one setup asks. Put more into one call, or pass over the smaller things: they wait until a bill raises them.`);
        }
        const { key: slug, ...words } = { ...input, refs: cites };
        await prisma.integrationSetupCall.upsert({
          where: { setupId_key: { setupId: ctx.setupId, key: slug } },
          create: { setupId: ctx.setupId, key: slug, ...words },
          update: { ...words, status: 'open' },
        });
        await appendEvent(ctx.setupId, 'call_opened', { key: slug, kind: input.kind, refs });
        return { opened: slug, ...(existing?.status === 'answered' ? { note: 'It is open again. When they answer, whatever they don\'t mention stands.' } : {}) };
      },
    },
    {
      name: 'record_answer',
      description: 'Save what the person decided on a call. Only when they have just said so. A later answer only changes the vendors or lines it names, and the rest stands. What comes back as means is everything saved on this call: check it against what they said. On vendors and lines they read it above your message, so there is no need to say it again. value holds the usable part, by name, as the call or their books show it: closing_date {date: "YYYY-MM-DD"}, or {neverClosed: true} only if they said so; lookalike_vendors {same: [{keep, with: [...]}], apart: [...]}, same for each group they said is one vendor and apart for any to take back out of a group; vendors nobody names stay separate, so {same: []} is right when they all are; coded_two_ways {choices: [{vendor, line, category}]}, one for each line, with category null for a person to pick each time. answer is what they decided, in a few plain words.',
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
        await ctx.onThought({ text: 'Saving the answer' });
        const setup = await load(ctx.setupId);
        const call = await prisma.integrationSetupCall.findUnique({ where: { setupId_key: { setupId: ctx.setupId, key: input.key } } });
        if (!call) throw new Error(`There is no call called ${input.key}.`);
        const topic = CAME_UP[call.kind];
        if (topic) {
          const [talked, onCards] = await Promise.all([
            prisma.integrationSetupMessage.findMany({ where: { setupId: ctx.setupId, status: 'done' }, select: { text: true } }),
            cardAnswers(ctx.setupId),
          ]);
          // A question's card puts the question in front of them, so an answer written on it came up with them.
          const onItsCard = [...onCards.values()].includes(call.key);
          if (!onItsCard && !talked.some((m) => topic.test(m.text ?? ''))) throw new Error('This hasn\'t come up with them yet. Ask it in your message, and record it when they answer.');
        }
        if (call.kind === 'closing_date' && input.value?.date) {
          // Saying it again changes nothing. Refused, the model told them it couldn't save a date it already had.
          if (call.status === 'answered' && (call.value as { date?: unknown } | null)?.date === input.value.date) {
            return { recorded: input.key, means: await inWords(call, call.value, setup) };
          }
          const message = await prisma.integrationSetupMessage.findUnique({ where: { messageId: ctx.speaker.messageId }, select: { text: true } });
          if (!GAVE_OR_AGREED.test(message?.text ?? '')) throw new Error('They haven\'t given a date or agreed to one. Ask them, and record it when they do.');
        }
        const value = await answerValue(call, input.value, setup);
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
        const means = await inWords(call, value, setup);
        // A mapping has to be exact, so they read what was saved rather than what the model makes of it.
        if (means && (call.kind === 'lookalike_vendors' || call.kind === 'coded_two_ways')) ctx.saved.set(input.key, means);
        return { recorded: input.key, means };
      },
    },
    {
      name: 'offer_go',
      description: 'Ask to put the Go button under your message. Code decides: if anything is missing you hear what. Whatever their books show that the person hasn\'t heard from you comes back as notRaised, with its refs: ask them, or, if no question of yours cites it, pass it over here with the reason it can wait. Only the person can press it.',
      parameters: {
        type: 'object',
        properties: {
          passedOver: {
            type: 'array',
            description: 'What notRaised listed that isn\'t worth their time, with why. It goes on the record.',
            items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } },
          },
        },
      },
      run: async (args) => {
        await ctx.onThought({ text: 'Checking what Go still needs' });
        const setup = await load(ctx.setupId);
        const conditions = await doneConditions(setup);
        const [calls, told, earlier] = await Promise.all([
          prisma.integrationSetupCall.findMany({ where: { setupId: ctx.setupId }, select: { kind: true, refs: true } }),
          prisma.integrationSetupMessage.findMany({ where: { setupId: ctx.setupId, status: 'done' }, select: { text: true, claims: true } }),
          prisma.integrationSetupEvent.findMany({ where: { setupId: ctx.setupId, kind: 'tool_call', payload: { path: ['tool'], equals: 'offer_go' } }, select: { payload: true } }),
        ]);
        const claimsOf = (m: { claims: unknown }) => (Array.isArray(m.claims) ? (m.claims as Array<{ text: string; refs: string[] }>) : []);
        const said = wordsSaid(told.flatMap((m) => [m.text ?? '', ...claimsOf(m).map((c) => c.text)]));
        const claimed = new Set(told.flatMap((m) => claimsOf(m).flatMap((c) => c.refs ?? [])));
        // What it passed over stays passed over. What a question cites can't be: the person has to see what they're asked about.
        const passedOver = new Set([
          ...earlier.flatMap((e) => ((e.payload as { args?: { passedOver?: Array<{ id: string }> } }).args?.passedOver ?? []).map((p) => p.id)),
          ...(parsed(OFFER_GO, args).passedOver ?? []).map((p) => p.id),
        ]);
        const left = notRaised(setup.findings as StudyFindings | null, calls, said, claimed).filter((n) => n.inACall || !passedOver.has(n.id));
        if (!readyForGo(conditions) || left.length > 0) {
          return {
            offered: false,
            ...(readyForGo(conditions) ? {} : { stillNeeded: stillMissing(conditions) }),
            ...(left.length > 0 ? { notRaised: left } : {}),
            ...(left.some((n) => n.inACall) ? { note: 'Your questions ask about these, but they were never named to the person. Set list when you respond, and they see them.' } : {}),
          };
        }
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
