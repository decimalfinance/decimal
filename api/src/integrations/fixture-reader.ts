// A company in memory, read through the same interface as a real system. Tests and
// evals use it, so a study runs for real with no network. It can also fail the way
// a system does, because a failed read has to look nothing like an empty company.

import { BooksReadError, type BooksAccount, type BooksBill, type BooksCompany, type BooksExpense, type BooksRead, type BooksReader, type BooksVendor } from './books.js';

export type BooksFixture = {
  company: BooksCompany;
  accounts: BooksAccount[];
  vendors: BooksVendor[];
  bills: BooksBill[];
  expenses: BooksExpense[];
};

export type FixtureFault = {
  /** Which read fails. */
  on: 'company' | 'accounts' | 'vendors' | 'bills' | 'expenses';
  error?: BooksReadError;
  /** Or: the read works but this many records do not come back. */
  short?: number;
};

export function fixtureReader(fixture: BooksFixture, faults: FixtureFault[] = [], system = 'fixture'): BooksReader {
  const fail = (on: FixtureFault['on']) => {
    const fault = faults.find((f) => f.on === on && f.error);
    if (fault?.error) throw fault.error;
  };
  const read = <T>(on: FixtureFault['on'], records: T[]): BooksRead<T> => {
    fail(on);
    const short = faults.find((f) => f.on === on)?.short ?? 0;
    return {
      records: short > 0 ? records.slice(0, Math.max(0, records.length - short)) : records,
      expected: records.length,
      missing: short,
      problems: short > 0 ? [`${short} records did not come back`] : [],
    };
  };
  const dated = <T extends { date: string | null }>(records: T[], since: string) => records.filter((r) => r.date !== null && r.date >= since);
  return {
    system,
    companyId: fixture.company.id,
    company: async () => {
      fail('company');
      return fixture.company;
    },
    closingDate: async () => {
      fail('company');
      return fixture.company.closingDate;
    },
    accounts: async () => read('accounts', fixture.accounts),
    vendors: async () => read('vendors', fixture.vendors),
    bills: async (since) => read('bills', dated(fixture.bills, since)),
    expenses: async (since) => read('expenses', dated(fixture.expenses, since)),
    // As QuickBooks does it: numbers ignore case, and a vendor's bills are dated on or after.
    billsLike: async ({ numbers, vendorIds, since }) => {
      fail('bills');
      const wanted = new Set(numbers.map((n) => n.toLowerCase()));
      return fixture.bills.filter((b) => (b.number !== null && wanted.has(b.number.toLowerCase()))
        || (b.vendorId !== null && vendorIds.includes(b.vendorId) && b.date !== null && b.date >= since));
    },
  };
}

export const failure = (kind: BooksReadError['kind'], message = `${kind}.`) => new BooksReadError(kind, message);
