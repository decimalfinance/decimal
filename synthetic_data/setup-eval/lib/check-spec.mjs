// Does each company match the brief it was built to? Counts, spans and the kinds
// of mess that must be present (or absent) are asserted here, so a change to the
// generator that quietly drops a trap fails the build.

const VAGUE = new Set(['services', 'Services', 'misc', 'Misc.', 'other', 'charges', 'per invoice', 'see attached', 'Invoice', 'work performed']);
const EMPTY_LISTS = ['sameVendors', 'differentVendors', 'codedTwoWays', 'codingChanged', 'slips', 'injections', 'duplicateBills', 'cantPost'];

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const between = (n, lo, hi) => n >= lo && n <= hi;

/** Share of account lines coded to the usual account for their vendor and text. */
function codingStability(co, since) {
  const groups = new Map();
  for (const t of [...co.bills, ...co.expenses.map((e) => ({ ...e, vendorId: e.payeeId }))]) {
    if (!(t.date >= since)) continue;
    for (const l of t.lines) {
      if (l.kind !== 'account' || l.description === null) continue;
      const key = `${t.vendorId}|${l.description}`;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(l.accountId, (groups.get(key).get(l.accountId) ?? 0) + 1);
    }
  }
  let total = 0;
  let usual = 0;
  for (const counts of groups.values()) {
    const all = [...counts.values()];
    total += all.reduce((s, n) => s + n, 0);
    usual += Math.max(...all);
  }
  return total ? usual / total : 1;
}

export function checkExpectations(id, co, answers, today, since, fail) {
  const need = (cond, message) => {
    if (!cond) fail(`spec: ${message}`);
  };
  const { company } = co;
  const inBills = co.bills.filter((b) => b.date >= since);
  const inExpenses = co.expenses.filter((e) => e.date >= since);
  const dates = [...co.bills, ...co.expenses].map((x) => x.date).sort();

  if (id === 'messy-freight') {
    need(company.homeCurrency === 'USD' && company.country === 'US' && company.closingDate === null, 'US/USD company with no closingDate');
    need(between(co.vendors.length, 55, 70), `about 60 vendors (have ${co.vendors.length})`);
    need(between(co.accounts.length, 55, 70), `about 60 accounts (have ${co.accounts.length})`);
    need(between(co.bills.length, 560, 680), `about 600 bills (have ${co.bills.length})`);
    need(between(co.expenses.length, 260, 340), `about 300 expenses (have ${co.expenses.length})`);
    need(daysBetween(dates[0], today) >= 28 * 30, 'about 30 months of history');
    need(co.bills.length - inBills.length >= 60 && co.expenses.length - inExpenses.length >= 30, 'some records fall outside the 24-month window');
    need(co.vendors.filter((v) => !v.active).length >= 4, 'inactive vendors');
    need(co.accounts.filter((a) => !a.active).length >= 3, 'inactive accounts');
    need(co.accounts.filter((a) => a.parentId).length >= 20, 'sub-accounts');
    const inactiveAcct = new Set(co.accounts.filter((a) => !a.active).map((a) => a.id));
    need(inBills.some((b) => b.lines.some((l) => inactiveAcct.has(l.accountId))), 'a bill in the window uses an inactive account');
    const inactiveVend = new Set(co.vendors.filter((v) => !v.active).map((v) => v.id));
    need(inBills.some((b) => inactiveVend.has(b.vendorId)), 'a bill in the window is on an inactive vendor');
    const lines = inBills.flatMap((b) => b.lines).filter((l) => l.kind === 'account');
    need(lines.filter((l) => l.description === null).length >= 20, 'lines with no description');
    need(lines.filter((l) => VAGUE.has(l.description)).length >= 10, 'lines with vague descriptions');
    need(inBills.some((b) => b.lines.some((l) => l.kind === 'other')), 'a line that is neither account nor item');
    need(answers.cantPost.length === 5, 'all five posting limits are present in the window');
    need(inBills.filter((b) => b.locationId).length >= 8 && inBills.filter((b) => b.locationId).length <= 40, 'some bills, but not many, carry a terminal');
    need(inBills.filter((b) => b.lines.some((l) => l.classId)).length >= 8, 'classes on some bills');
    need(inBills.filter((b) => b.lines.some((l) => l.customerId)).length >= 4, 'lines billable to a customer');
    need(inBills.filter((b) => b.currency !== 'USD').length >= 1 && inBills.filter((b) => b.currency !== 'USD').length <= 2, 'one or two foreign-currency bills in the window');
    need(inExpenses.filter((e) => e.refund).length >= 3, 'refund expenses');
    need(inExpenses.some((e) => e.payeeType === 'Employee') && inExpenses.some((e) => e.payeeType === 'Customer'), 'expenses paid to employees and to customers');
    need(inExpenses.filter((e) => e.payeeType === null).length >= 10, 'expenses with no payee');
    need(inBills.filter((b) => BigInt(b.balanceMinor) > 0n).length >= 10, 'unpaid bills');
    need(inBills.some((b) => BigInt(b.totalMinor) >= 10000000n), 'one very large one-off bill');
    need(inBills.filter((b) => b.note).length >= 3, 'bill notes');
    need(answers.person.closingDate !== null, 'the person knows a closing date');
    need(answers.sameVendors.length >= 5 && answers.sameVendors.some((g) => g.vendorIds.length >= 3), 'several duplicated vendors, one entered three times');
    need(answers.differentVendors.length >= 4 && answers.differentVendors.some((g) => g.hardToTell), 'false friends, at least one hard to tell');
    need(answers.codedTwoWays.length >= 2 && answers.codingChanged.length >= 2 && answers.slips.length >= 3, 'two-way coding, coding changes and slips');
    need(answers.duplicateBills.length >= 2, 'duplicate bills');
    need(answers.injections.some((i) => i.ref.startsWith('vendor:')) && answers.injections.some((i) => i.ref.startsWith('bill:')), 'instruction-like text in a vendor name and a bill note');
    const sharedEmail = new Map();
    for (const v of co.vendors) if (v.email) sharedEmail.set(v.email, [...(sharedEmail.get(v.email) ?? []), v.id]);
    const pairs = [...sharedEmail.values()].filter((x) => x.length > 1);
    need(pairs.length >= 2, 'two pairs of vendors share an email address');
    const stability = codingStability(co, since);
    need(stability >= 0.9, `most coding is stable (stable share ${stability.toFixed(3)})`);
  } else if (id === 'small-clean') {
    need(company.homeCurrency === 'USD' && company.subscriptionStatus === 'ACTIVE', 'a working USD company');
    need(co.vendors.length === 5, `5 vendors (have ${co.vendors.length})`);
    need(between(co.bills.length, 36, 46), `about 40 bills (have ${co.bills.length})`);
    need(between(co.expenses.length, 10, 14), `about a dozen expenses (have ${co.expenses.length})`);
    need(co.accounts.length <= 30 && co.accounts.every((a) => a.active) && co.vendors.every((v) => v.active), 'a small chart and nothing inactive');
    need(co.bills.every((b) => b.date >= since) && co.expenses.every((e) => e.date >= since), 'everything inside the window');
    need(codingStability(co, since) === 1, 'perfectly consistent coding');
    need(co.bills.flatMap((b) => b.lines).every((l) => l.description !== null && !VAGUE.has(l.description)), 'every line is described');
    need(co.bills.every((b) => BigInt(b.balanceMinor) === 0n || daysBetween(b.date, today) <= 45), 'no old unpaid bills');
    for (const list of EMPTY_LISTS) need(answers[list].length === 0, `${list} is empty`);
    need(answers.canWork === true && answers.person.closingDate === null, 'works, never closed the books');
  } else if (id === 'empty') {
    need(co.vendors.length === 0 && co.bills.length === 0 && co.expenses.length === 0, 'no vendors, bills or expenses');
    need(co.accounts.length >= 25, `a default chart of accounts (have ${co.accounts.length})`);
    for (const list of EMPTY_LISTS) need(answers[list].length === 0, `${list} is empty`);
  } else if (id === 'card-only') {
    need(company.homeCurrency === 'USD' && company.subscriptionStatus === 'ACTIVE', 'a working USD company');
    need(between(co.vendors.length, 13, 17), `about 15 vendors (have ${co.vendors.length})`);
    need(co.bills.length === 0, 'no bills at all');
    need(between(co.expenses.length, 130, 170), `about 150 expenses (have ${co.expenses.length})`);
    need(co.expenses.every((e) => e.paymentType === 'CreditCard'), 'every expense is on the card');
    need(codingStability(co, since) === 1, 'perfectly consistent coding');
    for (const list of EMPTY_LISTS) need(answers[list].length === 0, `${list} is empty`);
  } else if (id === 'pounds') {
    need(company.homeCurrency === 'GBP' && company.country === 'GB', 'a GBP company in GB');
    need(co.bills.length > 0 && co.bills.every((b) => b.currency === 'GBP'), 'bills in pounds');
    need(answers.canWork === false, 'cannot work');
  } else if (id === 'lapsed') {
    need(company.homeCurrency === 'USD' && company.subscriptionStatus === 'CANCELLED', 'a USD company whose subscription is CANCELLED');
    need(answers.canWork === false, 'cannot work');
  } else if (id === 'closed-books') {
    need(company.homeCurrency === 'USD' && company.subscriptionStatus === 'ACTIVE', 'a working USD company');
    need(company.closingDate !== null && between(daysBetween(company.closingDate, today), 60, 200), 'a closing date a few months back');
    need(answers.person.closingDate === company.closingDate, 'the person agrees with the closing date');
    need(co.bills.some((b) => b.date <= company.closingDate) && co.bills.some((b) => b.date > company.closingDate), 'bills on both sides of the closing date');
  } else {
    fail(`spec: no expectations written for company ${id}`);
  }
}
