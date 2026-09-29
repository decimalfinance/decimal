// What the companion can look at when someone asks it something.
//
// Every tool is read-only and sees exactly what the person asking can see: the
// bills come from the same workbench the Bills page shows them, which already
// narrows an approver to the bills they are involved in. The companion cannot
// see further than the person it is answering.
//
// Each call also says, in a sentence, what it did — that is the "thought" the
// chat shows while the answer is worked out.
import { prisma } from '../infra/prisma.js';
import { getBillsWorkbench } from '../payments/bills.js';
import type { AgentTool } from '../exceptions/agent.js';
import { getCompanionConsole } from './today.js';
import { plural } from './steps.js';

type Workbench = Awaited<ReturnType<typeof getBillsWorkbench>>;
type Row = Workbench['bills'][number];

export type Thought = { text: string; detail: string | null };

const STATUS_WORDS: Record<string, string> = {
  draft: 'in review',
  in_approval: 'in approval',
  to_pay: 'approved, to pay',
  done: 'paid',
  needs_attention: 'needs attention',
};

export function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * A calendar day in the server's own time zone, the same one the flags and the
 * rest of the product speak in. UTC dates had the chat saying 29 Sep about a
 * bill a flag called 30 Sep.
 */
export function localDay(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function day(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return localDay(typeof d === 'string' ? new Date(d) : d);
}

function parseDay(s: unknown, endOfDay = false): Date | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return endOfDay ? new Date(d.getTime() + 86_400_000 - 1) : d;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function vendorMatches(row: Row, query: unknown): boolean {
  if (typeof query !== 'string' || !query.trim()) return true;
  return norm(row.vendorName).includes(norm(query));
}

function brief(row: Row) {
  return {
    billId: row.paymentOrderId,
    vendor: row.vendorName,
    invoiceNumber: row.invoiceNumber,
    amountUsd: row.amountUsd,
    status: STATUS_WORDS[row.bucket] ?? row.bucket,
    detail: row.subStatus.text,
    received: day(row.createdAt),
    due: day(row.dueAt),
    needsAttention: row.companion && !row.companion.ready ? row.companion.reason : null,
    blocked: row.blocking,
  };
}

const NULLABLE_STRING = { type: ['string', 'null'] };
const NULLABLE_NUMBER = { type: ['number', 'null'] };
const STATUS_PARAM = {
  type: ['string', 'null'],
  enum: ['in_review', 'in_approval', 'to_pay', 'paid', 'needs_attention', null],
  description: 'Only bills in this state. Null for any state.',
};
const STATUS_TO_BUCKET: Record<string, string> = {
  in_review: 'draft', in_approval: 'in_approval', to_pay: 'to_pay', paid: 'done', needs_attention: 'needs_attention',
};

/**
 * The tools for one person's question. `onThought` receives a sentence per
 * call, as it finishes. `seen` collects every bill a tool returned, so an answer
 * can only point at bills that were actually looked at.
 */
export function chatTools(args: {
  organizationId: string;
  viewerUserId: string;
  onThought: (t: Thought) => Promise<void>;
  seen: Set<string>;
}): AgentTool[] {
  let board: Workbench | null = null;
  const bills = async () => {
    board ??= await getBillsWorkbench(args.organizationId, args.viewerUserId);
    return board.bills;
  };
  const filterRows = (rows: Row[], a: Record<string, unknown>) => {
    const from = parseDay(a.from);
    const to = parseDay(a.to, true);
    const bucket = typeof a.status === 'string' ? STATUS_TO_BUCKET[a.status] : null;
    return rows.filter((r) =>
      vendorMatches(r, a.vendor)
      && (!bucket || r.bucket === bucket)
      && (!from || r.createdAt >= from)
      && (!to || r.createdAt <= to)
      && (typeof a.minAmount !== 'number' || r.amountUsd >= a.minAmount)
      && (typeof a.maxAmount !== 'number' || r.amountUsd <= a.maxAmount));
  };
  const scope = (a: Record<string, unknown>) => {
    const parts: string[] = [];
    if (typeof a.vendor === 'string' && a.vendor.trim()) parts.push(`from ${a.vendor.trim()}`);
    if (typeof a.status === 'string') parts.push(a.status.replace('_', ' '));
    if (typeof a.from === 'string' || typeof a.to === 'string') parts.push(`received ${a.from ?? 'any time'} to ${a.to ?? 'today'}`);
    if (typeof a.minAmount === 'number') parts.push(`over ${usd(a.minAmount)}`);
    if (typeof a.maxAmount === 'number') parts.push(`under ${usd(a.maxAmount)}`);
    return parts.length ? ` ${parts.join(', ')}` : '';
  };

  return [
    {
      name: 'find_bills',
      description: 'Search the bills this person can see. Filter by vendor (partial name), state, the date the bill was received (YYYY-MM-DD), and amount in USD. Returns the count, the total, and up to 25 bills, newest first, each with a billId you can cite.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vendor: NULLABLE_STRING,
          status: STATUS_PARAM,
          from: { ...NULLABLE_STRING, description: 'Received on or after, YYYY-MM-DD.' },
          to: { ...NULLABLE_STRING, description: 'Received on or before, YYYY-MM-DD.' },
          minAmount: NULLABLE_NUMBER,
          maxAmount: NULLABLE_NUMBER,
          needsAttentionOnly: { type: ['boolean', 'null'], description: 'Only drafts that need a person, with the reason.' },
        },
      },
      run: async (a) => {
        let rows = filterRows(await bills(), a);
        if (a.needsAttentionOnly === true) rows = rows.filter((r) => r.companion && !r.companion.ready);
        const total = rows.reduce((s, r) => s + r.amountUsd, 0);
        const shown = rows.slice(0, 25);
        for (const r of shown) args.seen.add(r.paymentOrderId);
        await args.onThought({
          text: `Searched bills${scope(a)}`,
          detail: rows.length === 0 ? 'Found none.' : `Found ${plural(rows.length, 'bill')}, ${usd(total)} in total.`,
        });
        return { count: rows.length, totalUsd: Math.round(total * 100) / 100, bills: shown.map(brief), truncated: rows.length > shown.length };
      },
    },
    {
      name: 'get_bill',
      description: 'One bill in full: vendor, figures, dates, state, its lines with categories, its flags, and why it needs a person if it does.',
      parameters: { type: 'object', additionalProperties: false, properties: { billId: { type: 'string' } }, required: ['billId'] },
      run: async (a) => {
        const row = (await bills()).find((r) => r.paymentOrderId === a.billId);
        if (!row) {
          await args.onThought({ text: 'Looked for a bill I could not find', detail: null });
          return { error: 'No such bill, or this person cannot see it.' };
        }
        args.seen.add(row.paymentOrderId);
        const [coding, order] = await Promise.all([
          prisma.paymentOrderGlCoding.findUnique({ where: { paymentOrderId: row.paymentOrderId }, select: { lines: true } }),
          prisma.paymentOrder.findUnique({ where: { paymentOrderId: row.paymentOrderId }, select: { metadataJson: true } }),
        ]);
        const extracted = ((order?.metadataJson as Record<string, any> | null)?.agent?.extracted ?? {}) as Record<string, any>;
        const lines = Array.isArray(coding?.lines) && (coding!.lines as unknown[]).length > 0
          ? (coding!.lines as Array<Record<string, unknown>>).map((l) => ({ description: l.description ?? null, amount: l.amount ?? null, category: l.accountName ?? null }))
          : (Array.isArray(extracted.lineItems) ? extracted.lineItems : []).map((l: Record<string, unknown>) => ({ description: l.description ?? null, amount: l.amount ?? null, category: null }));
        await args.onThought({ text: `Opened ${row.vendorName}${row.invoiceNumber ? ` ${row.invoiceNumber}` : ''}`, detail: `${usd(row.amountUsd)}, ${STATUS_WORDS[row.bucket] ?? row.bucket}.` });
        return {
          ...brief(row),
          invoiceDate: extracted.invoiceDate ?? null,
          description: row.description,
          lines,
          categorised: Boolean(coding),
          flags: row.flags.map((f) => ({ kind: f.kind, what: f.short, detail: f.message, holdsTheBill: f.blocking })),
          duplicateCleared: row.duplicateCleared,
        };
      },
    },
    {
      name: 'spend_summary',
      description: 'Totals of bills grouped by vendor, category or month (by the date received). Filter by state and date range. Cancelled and rejected bills are left out. Category comes from how a bill was coded; bills not yet coded count as "Not categorised yet".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupBy: { type: 'string', enum: ['vendor', 'category', 'month'] },
          status: STATUS_PARAM,
          from: NULLABLE_STRING,
          to: NULLABLE_STRING,
          vendor: NULLABLE_STRING,
        },
        required: ['groupBy'],
      },
      run: async (a) => {
        const rows = filterRows(await bills(), a).filter((r) => r.bucket !== 'needs_attention');
        const groups = new Map<string, { total: number; count: number }>();
        const add = (key: string, amount: number) => {
          const g = groups.get(key) ?? { total: 0, count: 0 };
          g.total += amount; g.count += 1;
          groups.set(key, g);
        };
        if (a.groupBy === 'category') {
          const codings = await prisma.paymentOrderGlCoding.findMany({
            where: { organizationId: args.organizationId, paymentOrderId: { in: rows.map((r) => r.paymentOrderId) } },
            select: { paymentOrderId: true, lines: true, codedExpenseAccountName: true },
          });
          const byBill = new Map(codings.map((c) => [c.paymentOrderId, c]));
          for (const r of rows) {
            const c = byBill.get(r.paymentOrderId);
            const lines = (Array.isArray(c?.lines) ? c!.lines : []) as Array<{ accountName?: string | null; amount?: number }>;
            if (!c) add('Not categorised yet', r.amountUsd);
            else if (lines.length === 0) add(c.codedExpenseAccountName ?? 'Uncategorised', r.amountUsd);
            else for (const l of lines) add(l.accountName ?? 'Uncategorised', Number(l.amount) || 0);
          }
        } else {
          for (const r of rows) add(a.groupBy === 'month' ? localDay(r.createdAt).slice(0, 7) : r.vendorName, r.amountUsd);
        }
        const out = [...groups.entries()]
          .map(([key, g]) => ({ [a.groupBy as string]: key, totalUsd: Math.round(g.total * 100) / 100, count: g.count }))
          .sort((x, y) => (a.groupBy === 'month' ? String(x.month).localeCompare(String(y.month)) : y.totalUsd - x.totalUsd));
        const total = rows.reduce((s, r) => s + r.amountUsd, 0);
        await args.onThought({
          text: `Added up spend by ${a.groupBy}${scope(a)}`,
          detail: `${plural(rows.length, 'bill')}, ${usd(total)} across ${plural(out.length, String(a.groupBy === 'category' ? 'category' : a.groupBy), a.groupBy === 'category' ? 'categories' : undefined)}.`,
        });
        return { groups: out, billCount: rows.length, totalUsd: Math.round(total * 100) / 100 };
      },
    },
    {
      name: 'vendor_profile',
      description: 'Everything about one vendor from this person\'s bills: how many, total and average amount, first and latest bill, what is open, and the category habit if one has been learned or set.',
      parameters: { type: 'object', additionalProperties: false, properties: { vendor: { type: 'string' } }, required: ['vendor'] },
      run: async (a) => {
        const rows = (await bills()).filter((r) => vendorMatches(r, a.vendor));
        if (rows.length === 0) {
          await args.onThought({ text: `Looked up ${String(a.vendor)}`, detail: 'No bills from a vendor by that name.' });
          return { found: false };
        }
        const names = [...new Set(rows.map((r) => r.vendorName))];
        const counterparty = await prisma.counterparty.findFirst({
          where: { organizationId: args.organizationId, displayName: { in: names } },
          select: { counterpartyId: true, displayName: true },
        });
        const habit = counterparty
          ? await prisma.vendorCodingRule.findFirst({ where: { organizationId: args.organizationId, counterpartyId: counterparty.counterpartyId }, select: { accountName: true, accountId: true, source: true, learnedFromCount: true } })
          : null;
        const total = rows.reduce((s, r) => s + r.amountUsd, 0);
        const sorted = [...rows].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
        const open = rows.filter((r) => r.bucket === 'draft' || r.bucket === 'in_approval' || r.bucket === 'needs_attention');
        for (const r of rows.slice(0, 25)) args.seen.add(r.paymentOrderId);
        await args.onThought({ text: `Looked up ${names.join(', ')}`, detail: `${plural(rows.length, 'bill')}, ${usd(total)} in total.` });
        return {
          found: true,
          vendors: names,
          billCount: rows.length,
          totalUsd: Math.round(total * 100) / 100,
          averageUsd: Math.round((total / rows.length) * 100) / 100,
          firstBill: day(sorted[0]!.createdAt),
          latestBill: day(sorted[sorted.length - 1]!.createdAt),
          open: open.map(brief),
          categoryHabit: habit ? { category: habit.accountName ?? habit.accountId, learned: habit.source === 'learned', fromBills: habit.learnedFromCount } : null,
        };
      },
    },
    {
      name: 'whats_waiting',
      description: 'The console for this person: what the companion is still working on, what is waiting on them (approvals, drafts that need input, drafts ready to sign off, bills sent back), what finished recently, and for admins who is holding approvals.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const c = await getCompanionConsole(args.organizationId, args.viewerUserId, new Date(), { recordVisit: false });
        for (const w of c.waiting) if (w.paymentOrderId) args.seen.add(w.paymentOrderId);
        for (const d of c.done) if (d.paymentOrderId) args.seen.add(d.paymentOrderId);
        await args.onThought({
          text: 'Checked what is waiting on you',
          detail: `${plural(c.waiting.length, 'thing')} waiting, ${c.running.length} running, ${c.done.length} done recently.`,
        });
        return {
          running: c.running.map((r) => ({ what: r.title, step: r.step })),
          waiting: c.waiting.map((w) => ({ kind: w.kind, billId: w.paymentOrderId, vendor: w.title, invoiceNumber: w.invoiceNumber, amountUsd: w.amountUsd, why: w.reason })),
          done: c.done.map((d) => ({ billId: d.paymentOrderId, what: d.title, outcome: d.outcome, at: d.at })),
          holdingApprovals: c.holding,
        };
      },
    },
  ];
}
