// What the study works out from a company's records, by code. The model decides
// what is worth saying and what to look into further. It never does this
// arithmetic, so a count it quotes is a count that was made.
//
// Everything here is pure, and comes out JSON-safe to keep on the setup.

import { minorToText, type BooksAccount, type BooksBill, type BooksCompany, type BooksExpense, type BooksVendor } from '../books.js';

/** Legal forms and filler: "Delta Inc." and "The Delta, LLC" are the same name. */
const NOISE_WORDS = new Set(['inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'the', 'plc', 'gmbh', 'pty', 'pvt', 'pte']);

/** A line seen this often, nearly always the same way, counts as how they work. */
const LEARNED_MIN_LINES = 3;
const LEARNED_MIN_SHARE = 0.9;
/** Two ways is real only if the second is more than a slip. */
const SECOND_WAY_MIN_LINES = 2;
const SECOND_WAY_MIN_SHARE = 0.2;
const MAX_LISTED = 20;

export type LookalikeVendors = {
  why: 'same_name' | 'same_email' | 'similar_name';
  vendors: Array<{ id: string; name: string; active: boolean; bills: number; expenses: number; lastUsed: string | null }>;
};

export type CodedTwoWays = {
  vendorId: string;
  vendorName: string;
  /** The line's words, or null when its lines have none and the vendor as a whole is what varies. */
  line: string | null;
  accounts: Array<{ id: string; name: string; lines: number; lastUsed: string | null }>;
};

export type CantPost = {
  kind: 'item_lines' | 'classes' | 'locations' | 'other_currency' | 'billable_to_customer';
  /** Bills it shows up on. */
  bills: number;
  /** Up to five, to open. */
  sampleBillIds: string[];
};

export type Findings = {
  company: { id: string; name: string; homeCurrency: string | null };
  window: { since: string; firstBill: string | null; lastBill: string | null };
  counts: { accounts: number; activeAccounts: number; vendors: number; activeVendors: number; bills: number; expenses: number; billsUnpaid: number };
  /** In the home currency only. */
  totals: { bills: string; expenses: string; unpaid: string };
  /** Where a bill's lines go, busiest first. */
  accountsBillsUse: Array<{ id: string; name: string; lines: number }>;
  busiestVendors: Array<{ id: string; name: string; bills: number; expenses: number; total: string }>;
  lookalikeVendors: LookalikeVendors[];
  codedTwoWays: CodedTwoWays[];
  /** Vendor and line pairs that are repeated and consistent: what Decimal can fill in from day one. */
  learned: { pairs: number; lines: number; sample: Array<{ vendorId: string; vendorName: string; line: string | null; categoryId: string; accountName: string; lines: number }> };
  cantPost: CantPost[];
  /** Reads that came back short. Over zero has to be told to the person. */
  shortfalls: Array<{ what: string; expected: number; read: number; problems: string[] }>;
};

export type StudyInput = {
  company: BooksCompany;
  since: string;
  accounts: { records: BooksAccount[]; expected: number; missing: number; problems: string[] };
  vendors: { records: BooksVendor[]; expected: number; missing: number; problems: string[] };
  bills: { records: BooksBill[]; expected: number; missing: number; problems: string[] };
  expenses: { records: BooksExpense[]; expected: number; missing: number; problems: string[] };
};

/** A vendor's name as a comparison key: case, punctuation and legal form gone. */
export function cleanName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept = words.filter((w) => !NOISE_WORDS.has(w));
  return (kept.length > 0 ? kept : words).join(' ');
}

const cleanLine = (text: string | null) => {
  const words = text?.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) ?? [];
  return words.length > 0 ? words.join(' ') : null;
};

/** Edit distance, giving up past `max`. */
function closeEnough(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      current[j] = cost;
      best = Math.min(best, cost);
    }
    if (best > max) return false;
    previous = current;
  }
  return previous[b.length]! <= max;
}

/** "Store 12" and "Store 13" are two stores, however close they spell. */
const digitsOf = (name: string) => name.replace(/\D/g, '');

function similarNames(a: string, b: string): boolean {
  if (a[0] !== b[0] || digitsOf(a) !== digitsOf(b)) return false;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  return closeEnough(a, b, shorter >= 8 ? 2 : 1);
}

type Activity = { bills: number; expenses: number; lastUsed: string | null };

function findLookalikes(vendors: BooksVendor[], activity: Map<string, Activity>): LookalikeVendors[] {
  const parent = new Map(vendors.map((v) => [v.id, v.id]));
  const reasons = new Map<string, LookalikeVendors['why']>();
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const join = (a: string, b: string, why: LookalikeVendors['why']) => {
    const [ra, rb] = [root(a), root(b)];
    if (ra === rb) return;
    parent.set(rb, ra);
    // The strongest reason wins: the same name says more than the same inbox, which says more than close spelling.
    const order: Array<LookalikeVendors['why']> = ['same_name', 'same_email', 'similar_name'];
    const known = [why, reasons.get(ra), reasons.get(rb)].filter((r): r is LookalikeVendors['why'] => Boolean(r));
    reasons.set(ra, order.find((o) => known.includes(o))!);
  };

  const byName = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const named = vendors.map((v) => ({ id: v.id, clean: cleanName(v.name) }));
  for (const v of vendors) {
    const clean = cleanName(v.name);
    const sameName = byName.get(clean);
    if (sameName) join(sameName, v.id, 'same_name');
    else byName.set(clean, v.id);
    const email = v.email?.toLowerCase();
    if (email) {
      const sameEmail = byEmail.get(email);
      if (sameEmail) join(sameEmail, v.id, 'same_email');
      else byEmail.set(email, v.id);
    }
  }
  // Only names starting alike are compared, which keeps this far from n squared.
  const byFirst = new Map<string, typeof named>();
  for (const v of named) byFirst.set(v.clean[0] ?? '', [...(byFirst.get(v.clean[0] ?? '') ?? []), v]);
  for (const group of byFirst.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (group[i]!.clean !== group[j]!.clean && similarNames(group[i]!.clean, group[j]!.clean)) join(group[i]!.id, group[j]!.id, 'similar_name');
      }
    }
  }

  const groups = new Map<string, BooksVendor[]>();
  for (const v of vendors) groups.set(root(v.id), [...(groups.get(root(v.id)) ?? []), v]);
  const used = (v: BooksVendor) => {
    const a = activity.get(v.id);
    return (a?.bills ?? 0) + (a?.expenses ?? 0);
  };
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    // Look-alikes nobody uses can't send a bill the wrong way.
    .filter(([, members]) => members.filter((v) => used(v) > 0 || v.active).length > 1)
    .map(([id, members]) => ({
      why: reasons.get(id) ?? 'similar_name',
      vendors: [...members].sort((a, b) => used(b) - used(a)).map((v) => ({
        id: v.id,
        name: v.name,
        active: v.active,
        bills: activity.get(v.id)?.bills ?? 0,
        expenses: activity.get(v.id)?.expenses ?? 0,
        lastUsed: activity.get(v.id)?.lastUsed ?? null,
      })),
    }))
    .sort((a, b) => b.vendors.reduce((n, v) => n + v.bills + v.expenses, 0) - a.vendors.reduce((n, v) => n + v.bills + v.expenses, 0))
    .slice(0, MAX_LISTED);
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export function computeFindings(input: StudyInput): Findings {
  const { company, accounts, vendors, bills, expenses } = input;
  const home = company.homeCurrency ?? 'USD';
  const vendorName = new Map(vendors.records.map((v) => [v.id, v.name]));
  const accountName = new Map(accounts.records.map((a) => [a.id, a.fullName]));

  const activity = new Map<string, Activity>();
  const spend = new Map<string, bigint>();
  const touch = (id: string | null, kind: 'bills' | 'expenses', date: string | null, currency: string, total: bigint) => {
    if (!id) return;
    const a = activity.get(id) ?? { bills: 0, expenses: 0, lastUsed: null };
    a[kind] += 1;
    a.lastUsed = later(a.lastUsed, date);
    activity.set(id, a);
    if (currency === home) spend.set(id, (spend.get(id) ?? 0n) + total);
  };
  for (const b of bills.records) touch(b.vendorId, 'bills', b.date, b.currency, b.totalMinor);
  for (const e of expenses.records) {
    if (e.payeeType === null || e.payeeType === 'Vendor') touch(e.payeeId, 'expenses', e.date, e.currency, e.refund ? -e.totalMinor : e.totalMinor);
  }

  // Every coded line, on bills and expenses alike: both are how the team has categorised this vendor.
  type Way = { lines: number; lastUsed: string | null };
  const pairs = new Map<string, { vendorId: string; line: string | null; ways: Map<string, Way> }>();
  const billLines = new Map<string, number>();
  const note = (vendorId: string | null, date: string | null, line: { kind: string; accountId: string | null; description: string | null }) => {
    if (!vendorId || line.kind !== 'account' || !line.accountId) return;
    const words = cleanLine(line.description);
    const key = `${vendorId}\u0000${words ?? ''}`;
    const pair = pairs.get(key) ?? { vendorId, line: words, ways: new Map<string, Way>() };
    const way = pair.ways.get(line.accountId) ?? { lines: 0, lastUsed: null };
    way.lines += 1;
    way.lastUsed = later(way.lastUsed, date);
    pair.ways.set(line.accountId, way);
    pairs.set(key, pair);
  };
  for (const b of bills.records) {
    for (const l of b.lines) {
      note(b.vendorId, b.date, l);
      if (l.accountId) billLines.set(l.accountId, (billLines.get(l.accountId) ?? 0) + 1);
    }
  }
  for (const e of expenses.records) {
    if (e.payeeType !== null && e.payeeType !== 'Vendor') continue;
    for (const l of e.lines) note(e.payeeId, e.date, l);
  }

  const codedTwoWays: CodedTwoWays[] = [];
  const learnedSample: Findings['learned']['sample'] = [];
  let learnedPairs = 0;
  let learnedLines = 0;
  for (const pair of pairs.values()) {
    const ways = [...pair.ways.entries()].sort((a, b) => b[1].lines - a[1].lines);
    const total = ways.reduce((n, [, w]) => n + w.lines, 0);
    const top = ways[0]!;
    const second = ways[1];
    if (total >= LEARNED_MIN_LINES && top[1].lines / total >= LEARNED_MIN_SHARE) {
      learnedPairs += 1;
      learnedLines += total;
      learnedSample.push({ vendorId: pair.vendorId, vendorName: vendorName.get(pair.vendorId) ?? pair.vendorId, line: pair.line, categoryId: top[0], accountName: accountName.get(top[0]) ?? top[0], lines: top[1].lines });
    }
    if (second && second[1].lines >= SECOND_WAY_MIN_LINES && second[1].lines / total >= SECOND_WAY_MIN_SHARE) {
      codedTwoWays.push({
        vendorId: pair.vendorId,
        vendorName: vendorName.get(pair.vendorId) ?? pair.vendorId,
        line: pair.line,
        accounts: ways.map(([id, w]) => ({ id, name: accountName.get(id) ?? id, lines: w.lines, lastUsed: w.lastUsed })),
      });
    }
  }
  const linesIn = (c: CodedTwoWays) => c.accounts.reduce((n, a) => n + a.lines, 0);

  const cantPost: CantPost[] = [];
  const noteIf = (kind: CantPost['kind'], matches: (b: BooksBill) => boolean) => {
    const found = bills.records.filter(matches);
    if (found.length > 0) cantPost.push({ kind, bills: found.length, sampleBillIds: found.slice(0, 5).map((b) => b.id) });
  };
  noteIf('item_lines', (b) => b.lines.some((l) => l.kind === 'item'));
  noteIf('classes', (b) => b.lines.some((l) => l.classId));
  noteIf('locations', (b) => Boolean(b.locationId));
  noteIf('other_currency', (b) => b.currency !== home);
  noteIf('billable_to_customer', (b) => b.lines.some((l) => l.customerId));

  const inHome = <T extends { currency: string }>(rows: T[]) => rows.filter((r) => r.currency === home);
  const sum = (values: bigint[]) => values.reduce((n, v) => n + v, 0n);
  const dates = bills.records.map((b) => b.date).filter((d): d is string => Boolean(d)).sort();

  return {
    company: { id: company.id, name: company.name, homeCurrency: company.homeCurrency },
    window: { since: input.since, firstBill: dates[0] ?? null, lastBill: dates.at(-1) ?? null },
    counts: {
      accounts: accounts.records.length,
      activeAccounts: accounts.records.filter((a) => a.active).length,
      vendors: vendors.records.length,
      activeVendors: vendors.records.filter((v) => v.active).length,
      bills: bills.records.length,
      expenses: expenses.records.length,
      billsUnpaid: bills.records.filter((b) => (b.balanceMinor ?? 0n) !== 0n).length,
    },
    totals: {
      bills: minorToText(sum(inHome(bills.records).map((b) => b.totalMinor)), home),
      expenses: minorToText(sum(inHome(expenses.records).map((e) => (e.refund ? -e.totalMinor : e.totalMinor))), home),
      unpaid: minorToText(sum(inHome(bills.records).map((b) => b.balanceMinor ?? 0n)), home),
    },
    accountsBillsUse: [...billLines.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LISTED)
      .map(([id, lines]) => ({ id, name: accountName.get(id) ?? id, lines })),
    busiestVendors: [...activity.entries()]
      .filter(([id]) => vendorName.has(id))
      .sort((a, b) => (b[1].bills + b[1].expenses) - (a[1].bills + a[1].expenses))
      .slice(0, MAX_LISTED)
      .map(([id, a]) => ({ id, name: vendorName.get(id)!, bills: a.bills, expenses: a.expenses, total: minorToText(spend.get(id) ?? 0n, home) })),
    lookalikeVendors: findLookalikes(vendors.records, activity),
    codedTwoWays: codedTwoWays.sort((a, b) => linesIn(b) - linesIn(a)).slice(0, MAX_LISTED),
    learned: { pairs: learnedPairs, lines: learnedLines, sample: learnedSample.sort((a, b) => b.lines - a.lines).slice(0, 10) },
    cantPost,
    shortfalls: [
      { what: 'categories', read: accounts },
      { what: 'vendors', read: vendors },
      { what: 'bills', read: bills },
      { what: 'expenses', read: expenses },
    ]
      .filter(({ read }) => read.missing > 0)
      .map(({ what, read }) => ({ what, expected: read.expected, read: read.records.length, problems: read.problems.slice(0, 5) })),
  };
}

export type CompanyProblem = { code: 'not_usd' | 'subscription' ; blocking: boolean; detail: string };

/** What stops a company working with Decimal at all, checked before anyone is asked anything else. */
export function companyProblems(company: BooksCompany): CompanyProblem[] {
  const problems: CompanyProblem[] = [];
  if (company.homeCurrency && company.homeCurrency !== 'USD') {
    problems.push({ code: 'not_usd', blocking: true, detail: `The books are in ${company.homeCurrency}. Decimal works in USD for now.` });
  }
  const status = company.subscriptionStatus?.toUpperCase() ?? '';
  if (/(CANCEL|EXPIRED|SUSPEND|LAPSED|INACTIVE)/.test(status)) {
    problems.push({ code: 'subscription', blocking: true, detail: `The QuickBooks subscription shows as ${company.subscriptionStatus}.` });
  }
  return problems;
}
