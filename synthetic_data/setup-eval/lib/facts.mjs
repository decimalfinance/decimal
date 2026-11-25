// The numbers a student can be graded on, worked out from a finished fixture.
// (check.mjs works them out again from the files on disk, separately.)

import { addDays, addMonths, formatAmount, lastDayOfMonth, diffDays } from './util.mjs';

const big = (text) => BigInt(text ?? '0');

/** Records dated on or after `since` count. Totals count only the company's home currency; refunds come off expenses. */
export function computeFacts(fixture, since) {
  const home = fixture.company.homeCurrency;
  const bills = fixture.bills.filter((x) => x.date !== null && x.date >= since);
  const expenses = fixture.expenses.filter((x) => x.date !== null && x.date >= since);
  const homeBills = bills.filter((x) => x.currency === home);
  const homeExpenses = expenses.filter((x) => x.currency === home);
  const billsTotal = homeBills.reduce((s, x) => s + big(x.totalMinor), 0n);
  const unpaid = homeBills.reduce((s, x) => s + big(x.balanceMinor), 0n);
  const expensesTotal = homeExpenses.reduce((s, x) => s + (x.refund ? -big(x.totalMinor) : big(x.totalMinor)), 0n);
  return {
    since,
    bills: bills.length,
    billsUnpaid: bills.filter((x) => big(x.balanceMinor) > 0n).length,
    expenses: expenses.length,
    vendors: fixture.vendors.length,
    activeVendors: fixture.vendors.filter((x) => x.active).length,
    accounts: fixture.accounts.length,
    activeAccounts: fixture.accounts.filter((x) => x.active).length,
    billsTotalUsd: formatAmount(billsTotal),
    expensesTotalUsd: formatAmount(expensesTotal),
    unpaidUsd: formatAmount(unpaid),
  };
}

/** What Decimal could not post, among bills in the window: the five features the answer key names. */
export function computeCantPost(fixture, since) {
  const home = fixture.company.homeCurrency;
  const bills = fixture.bills.filter((x) => x.date !== null && x.date >= since);
  const lines = bills.flatMap((x) => x.lines);
  const found = new Set();
  if (lines.some((l) => l.kind === 'item')) found.add('item_lines');
  if (lines.some((l) => l.classId !== null)) found.add('classes');
  if (bills.some((x) => x.locationId !== null)) found.add('locations');
  if (bills.some((x) => x.currency !== home)) found.add('other_currency');
  if (lines.some((l) => l.customerId !== null)) found.add('billable_to_customer');
  return ['item_lines', 'classes', 'locations', 'other_currency', 'billable_to_customer'].filter((k) => found.has(k));
}

/** The last quarter end that is at least `minAgeDays` before today: when a careful small company has closed through. */
export function lastQuarterEnd(today, minAgeDays = 45) {
  let probe = lastDayOfMonth(`${today.slice(0, 7)}-01`);
  for (let i = 0; i < 24; i += 1) {
    const month = Number(probe.slice(5, 7));
    if (month % 3 === 0 && diffDays(probe, today) >= minAgeDays) return probe;
    probe = lastDayOfMonth(addMonths(`${probe.slice(0, 7)}-01`, -1));
  }
  return addDays(today, -120);
}

/** The last day of the month `monthsBack` months before today's month. */
export function endOfMonthBack(today, monthsBack) {
  return lastDayOfMonth(addMonths(`${today.slice(0, 7)}-01`, -monthsBack));
}
