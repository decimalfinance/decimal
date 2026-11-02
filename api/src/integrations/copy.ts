// The stored copy of a company's records. Written whole by the study; read by the
// model through structured lookups, always within one company. Amounts leave here
// as text ("1,080.07 USD"), and the sums are made here, so the model never does
// arithmetic it could get wrong.

import { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { minorToText, toMinor, type BooksAccount, type BooksBill, type BooksExpense, type BooksLine, type BooksVendor } from './books.js';

export const RECORD_KINDS = ['category', 'vendor', 'bill', 'expense'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The only way into the copy: it is what keeps one company's records from another's. */
export type CopyScope = { organizationId: string; system: string; companyId: string };

const WRITE_CHUNK = 1_000;
export const LOOKUP_DEFAULT = 20;
export const LOOKUP_MAX = 50;
const SUMMARY_MAX = 50;

type Row = {
  record_id: string;
  date: string | null;
  name: string | null;
  party_id: string | null;
  amount_minor: bigint | null;
  currency: string | null;
  search_text: string;
  data: unknown;
};

/** Bigints do not survive JSON, so they are stored as strings. */
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

const words = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' ').slice(0, 4000);

const lineWords = (lines: BooksLine[]) => lines.flatMap((l) => [l.description, l.accountName, l.itemName]);

const categoryRow = (a: BooksAccount): Row => ({
  record_id: a.id, date: null, name: a.fullName, party_id: null, amount_minor: null, currency: a.currency,
  search_text: words(a.fullName, a.number, a.type, a.subType), data: jsonSafe(a),
});

const vendorRow = (v: BooksVendor): Row => ({
  record_id: v.id, date: null, name: v.name, party_id: null, amount_minor: v.balanceMinor, currency: v.currency,
  search_text: words(v.name, v.company, v.email, v.accountNumber), data: jsonSafe(v),
});

const billRow = (b: BooksBill): Row => ({
  record_id: b.id, date: b.date, name: b.vendorName, party_id: b.vendorId, amount_minor: b.totalMinor, currency: b.currency,
  search_text: words(b.vendorName, b.number, b.note, ...lineWords(b.lines)), data: jsonSafe(b),
});

const expenseRow = (e: BooksExpense): Row => ({
  record_id: e.id, date: e.date, name: e.payeeName, party_id: e.payeeId, amount_minor: e.totalMinor, currency: e.currency,
  search_text: words(e.payeeName, e.number, e.note, e.paidFromAccountName, ...lineWords(e.lines)), data: jsonSafe(e),
});

export const toRows = { category: categoryRow, vendor: vendorRow, bill: billRow, expense: expenseRow };

/**
 * Replace one kind of record, whole. In one transaction, so a lookup sees the old
 * copy or the new one, and a record deleted in the books since the last read goes.
 */
export async function replaceRecords(scope: CopyScope, kind: RecordKind, rows: Row[]): Promise<void> {
  const base = { organizationId: scope.organizationId, system: scope.system, companyId: scope.companyId, kind };
  await prisma.$transaction(async (tx) => {
    await tx.booksRecord.deleteMany({ where: base });
    for (let at = 0; at < rows.length; at += WRITE_CHUNK) {
      await tx.booksRecord.createMany({
        data: rows.slice(at, at + WRITE_CHUNK).map((r) => ({
          ...base,
          recordId: r.record_id,
          date: r.date && isDate(r.date) ? new Date(`${r.date}T00:00:00Z`) : null,
          name: r.name,
          partyId: r.party_id,
          amountMinor: r.amount_minor,
          currency: r.currency,
          searchText: r.search_text,
          data: r.data as Prisma.InputJsonValue,
        })),
      });
    }
  }, { timeout: 120_000 });
}

/** Everything this organisation holds for a system, or everything but one company's. */
export async function deleteCopy(organizationId: string, system: string, except?: string): Promise<void> {
  await prisma.booksRecord.deleteMany({ where: { organizationId, system, ...(except ? { companyId: { not: except } } : {}) } });
}

export const refOf = (kind: RecordKind, id: string) => `${kind}:${id}`;

/** A real calendar date. The round trip matters: JavaScript reads 30 February as 2 March. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const money = (minor: unknown, currency: string | null) => {
  if (minor === null || minor === undefined) return null;
  return minorToText(BigInt(minor as string), currency ?? 'USD');
};

type StoredLine = Omit<BooksLine, 'amountMinor'> & { amountMinor: string };

function lineView(l: StoredLine, currency: string) {
  return {
    amount: money(l.amountMinor, currency),
    description: l.description,
    categoryId: l.accountId,
    category: l.accountName,
    ...(l.kind === 'item' ? { item: l.itemName, itemId: l.itemId } : {}),
    ...(l.className ? { class: l.className } : {}),
    ...(l.customerId ? { billableToCustomerId: l.customerId } : {}),
    ...(l.taxCode ? { taxCode: l.taxCode } : {}),
  };
}

/** A record as the model sees it: nothing in minor units, and with the ref to cite it by. */
function view(kind: RecordKind, data: any, full: boolean): Record<string, unknown> {
  const ref = refOf(kind, data.id);
  const cur: string = data.currency ?? 'USD';
  if (kind === 'category') {
    return { ref, id: data.id, name: data.fullName, number: data.number, type: data.type, subType: data.subType, active: data.active };
  }
  if (kind === 'vendor') {
    return {
      ref, id: data.id, name: data.name, email: data.email, active: data.active, owed: money(data.balanceMinor, data.currency),
      ...(full ? { company: data.company, phone: data.phone, address: data.address, accountNumber: data.accountNumber, currency: data.currency, createdAt: data.createdAt } : {}),
    };
  }
  const lines: StoredLine[] = data.lines ?? [];
  const shared = {
    ref, id: data.id, number: data.number, date: data.date, total: money(data.totalMinor, cur),
    linesCount: lines.length, lines: (full ? lines : lines.slice(0, 3)).map((l) => lineView(l, cur)),
    ...(data.locationName ? { location: data.locationName } : {}),
    ...(full ? { tax: money(data.taxMinor, cur), note: data.note, createdAt: data.createdAt } : {}),
  };
  if (kind === 'bill') {
    return { ...shared, vendorId: data.vendorId, vendor: data.vendorName, dueDate: data.dueDate, unpaid: money(data.balanceMinor, cur) };
  }
  return {
    ...shared, payeeId: data.payeeId, payee: data.payeeName, payeeType: data.payeeType, paymentType: data.paymentType,
    paidFrom: data.paidFromAccountName, ...(data.refund ? { refund: true } : {}),
  };
}

export type RecordFilters = {
  id?: string;
  vendorId?: string;
  categoryId?: string;
  text?: string;
  from?: string;
  to?: string;
  minAmount?: number;
  maxAmount?: number;
};

const SORTS = {
  newest: Prisma.sql`date DESC NULLS LAST, record_id`,
  oldest: Prisma.sql`date ASC NULLS LAST, record_id`,
  largest: Prisma.sql`amount_minor DESC NULLS LAST, record_id`,
  smallest: Prisma.sql`amount_minor ASC NULLS LAST, record_id`,
  name: Prisma.sql`name ASC NULLS LAST, record_id`,
};
export type RecordSort = keyof typeof SORTS;
export const RECORD_SORTS = Object.keys(SORTS) as RecordSort[];

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Each word, in any order, without the punctuation around it: "Tri-County Pallet Co." has to find "Tri-County Pallet Co - Dayton". */
const searchWords = (text: string) => text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);

function whereOf(scope: CopyScope, kind: RecordKind, filters: RecordFilters, homeCurrency: string): Prisma.Sql {
  const clauses = [
    Prisma.sql`organization_id = ${scope.organizationId}::uuid`,
    Prisma.sql`system = ${scope.system}`,
    Prisma.sql`company_id = ${scope.companyId}`,
    Prisma.sql`kind = ${kind}`,
  ];
  if (filters.id) clauses.push(Prisma.sql`record_id = ${filters.id}`);
  if (filters.vendorId) clauses.push(Prisma.sql`party_id = ${filters.vendorId}`);
  if (filters.categoryId) clauses.push(Prisma.sql`data->'lines' @> ${JSON.stringify([{ accountId: filters.categoryId }])}::jsonb`);
  if (filters.text) {
    // Only punctuation has no words, and is looked for as it is: it mustn't come to mean everything.
    const words = searchWords(filters.text);
    for (const word of words.length > 0 ? words : [filters.text]) clauses.push(Prisma.sql`search_text ILIKE ${`%${escapeLike(word)}%`}`);
  }
  if (filters.from) clauses.push(Prisma.sql`date >= ${filters.from}::date`);
  if (filters.to) clauses.push(Prisma.sql`date <= ${filters.to}::date`);
  // Dollars and yen cannot share a comparison, so an amount looks only at the books' own currency.
  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) clauses.push(Prisma.sql`currency = ${homeCurrency}`);
  if (filters.minAmount !== undefined) clauses.push(Prisma.sql`amount_minor >= ${toMinor(filters.minAmount, homeCurrency)}`);
  if (filters.maxAmount !== undefined) clauses.push(Prisma.sql`amount_minor <= ${toMinor(filters.maxAmount, homeCurrency)}`);
  return Prisma.join(clauses, ' AND ');
}

/** Dates and amounts the model made up are refused here, with a reason it can act on. */
export function checkFilters(filters: RecordFilters): string | null {
  for (const key of ['from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined && !isDate(value)) return `${key} must be a date, YYYY-MM-DD.`;
  }
  for (const key of ['minAmount', 'maxAmount'] as const) {
    const value = filters[key];
    if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e12)) return `${key} must be an amount.`;
  }
  return null;
}

export async function lookUp(
  scope: CopyScope,
  kind: RecordKind,
  filters: RecordFilters,
  options: { sort?: RecordSort; limit?: number; offset?: number; homeCurrency?: string } = {},
): Promise<{ total: number; returned: number; rows: Array<Record<string, unknown>> }> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? LOOKUP_DEFAULT)), LOOKUP_MAX);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const where = whereOf(scope, kind, filters, options.homeCurrency ?? 'USD');
  const order = SORTS[options.sort ?? (kind === 'bill' || kind === 'expense' ? 'newest' : 'name')];
  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ data: unknown }>>`SELECT data FROM books_records WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM books_records WHERE ${where}`,
  ]);
  return {
    total: Number(counted[0]?.n ?? 0),
    returned: rows.length,
    rows: rows.map((r) => view(kind, r.data, Boolean(filters.id))),
  };
}

export const SUMMARY_GROUPS = ['vendor', 'category', 'month'] as const;
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number];

/**
 * Bills or expenses, counted and added up. Only in the books' own currency, with
 * how many that left out. By category it is lines rather than records: one bill
 * can sit in several categories.
 */
export async function summarize(
  scope: CopyScope,
  kind: 'bill' | 'expense',
  by: SummaryGroup,
  filters: RecordFilters,
  homeCurrency: string,
): Promise<{ groupsTotal: number; groups: Array<{ key: string | null; name: string | null; count: number; total: string }>; otherCurrencyLeftOut: number }> {
  const where = whereOf(scope, kind, filters, homeCurrency);
  const home = Prisma.sql`${where} AND currency = ${homeCurrency}`;
  const [others] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM books_records WHERE ${where} AND currency IS DISTINCT FROM ${homeCurrency}`;
  const rows = await (by === 'category'
    ? prisma.$queryRaw<Array<{ key: string | null; name: string | null; count: bigint; total: bigint | null }>>`
        SELECT line->>'accountId' AS key, max(line->>'accountName') AS name, count(*) AS count, sum((line->>'amountMinor')::bigint)::bigint AS total
        FROM books_records, jsonb_array_elements(data->'lines') AS line
        WHERE ${home}
        GROUP BY line->>'accountId'
        ORDER BY total DESC NULLS LAST`
    : by === 'vendor'
      ? prisma.$queryRaw<Array<{ key: string | null; name: string | null; count: bigint; total: bigint | null }>>`
          SELECT party_id AS key, max(name) AS name, count(*) AS count, sum(amount_minor)::bigint AS total
          FROM books_records WHERE ${home}
          GROUP BY party_id
          ORDER BY total DESC NULLS LAST`
      : prisma.$queryRaw<Array<{ key: string | null; name: string | null; count: bigint; total: bigint | null }>>`
          SELECT to_char(date, 'YYYY-MM') AS key, to_char(date, 'YYYY-MM') AS name, count(*) AS count, sum(amount_minor)::bigint AS total
          FROM books_records WHERE ${home}
          GROUP BY to_char(date, 'YYYY-MM')
          ORDER BY key DESC NULLS LAST`);
  return {
    groupsTotal: rows.length,
    groups: rows.slice(0, SUMMARY_MAX).map((r) => ({ key: r.key, name: r.name, count: Number(r.count), total: minorToText(r.total ?? 0n, homeCurrency) })),
    otherCurrencyLeftOut: Number(others?.n ?? 0),
  };
}
