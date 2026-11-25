// Checks on a company file as it sits on disk: the shape the harness reads, the
// internal consistency real books have, and the numbers in `facts`, worked out
// again here without any of the generator's code.

const MINOR = /^-?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

const str = (x) => typeof x === 'string';
const strN = (x) => x === null || typeof x === 'string';
const bool = (x) => typeof x === 'boolean';
const minor = (x) => typeof x === 'string' && MINOR.test(x);
const minorN = (x) => x === null || minor(x);
const dateN = (x) => x === null || (typeof x === 'string' && DATE.test(x));
const stampN = (x) => x === null || (typeof x === 'string' && STAMP.test(x));
const oneOf = (...values) => (x) => values.includes(x);

const SHAPES = {
  company: { id: str, name: str, country: strN, homeCurrency: strN, plan: strN, subscriptionStatus: strN, fiscalYearStartMonth: strN, industry: strN, closingDate: dateN, multiCurrency: bool, salesTax: bool, accountNumbers: bool, classes: oneOf('off', 'per_transaction', 'per_line'), locations: bool, locationLabel: strN },
  account: { id: str, name: str, fullName: str, number: strN, type: strN, subType: strN, group: strN, parentId: strN, currency: strN, active: bool },
  vendor: { id: str, name: str, company: strN, email: strN, phone: strN, address: strN, accountNumber: strN, currency: strN, balanceMinor: minorN, termsId: strN, active: bool, createdAt: stampN, updatedAt: stampN },
  line: { amountMinor: minor, description: strN, kind: oneOf('account', 'item', 'other'), accountId: strN, accountName: strN, itemId: strN, itemName: strN, classId: strN, className: strN, customerId: strN, taxCode: strN },
  bill: { id: str, number: strN, vendorId: strN, vendorName: strN, date: dateN, dueDate: dateN, currency: str, totalMinor: minor, balanceMinor: minorN, taxMinor: minorN, payableAccountId: strN, termsId: strN, locationId: strN, locationName: strN, note: strN, lines: Array.isArray, createdAt: stampN, updatedAt: stampN },
  expense: { id: str, number: strN, payeeId: strN, payeeName: strN, payeeType: strN, date: dateN, currency: str, totalMinor: minor, taxMinor: minorN, paymentType: strN, paidFromAccountId: strN, paidFromAccountName: strN, refund: bool, locationId: strN, locationName: strN, note: strN, lines: Array.isArray, createdAt: stampN, updatedAt: stampN },
};

function shape(kind, record, where, fail) {
  const spec = SHAPES[kind];
  for (const [field, ok] of Object.entries(spec)) {
    if (!(field in record)) fail(`${where}: missing ${field}`);
    else if (!ok(record[field])) fail(`${where}: bad ${field} (${JSON.stringify(record[field])})`);
  }
  for (const field of Object.keys(record)) if (!(field in spec)) fail(`${where}: unexpected field ${field}`);
}

const sum = (list, pick) => list.reduce((s, x) => s + BigInt(pick(x)), 0n);

function unique(list, what, fail) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) fail(`duplicate ${what} id ${x.id}`);
    seen.add(x.id);
  }
  return seen;
}

/** "1,234.56" from minor units, written separately from the generator's. */
export function dollars(value) {
  const negative = value < 0n;
  let digits = String(negative ? -value : value);
  while (digits.length < 3) digits = `0${digits}`;
  const cents = digits.slice(-2);
  let whole = digits.slice(0, -2);
  let out = '';
  while (whole.length > 3) {
    out = `,${whole.slice(-3)}${out}`;
    whole = whole.slice(0, -3);
  }
  return `${negative ? '-' : ''}${whole}${out}.${cents}`;
}

export function recomputeFacts(co, since) {
  const home = co.company.homeCurrency;
  let billsTotal = 0n;
  let unpaid = 0n;
  let expensesTotal = 0n;
  let bills = 0;
  let billsUnpaid = 0;
  let expenses = 0;
  for (const bill of co.bills) {
    if (!(bill.date >= since)) continue;
    bills += 1;
    if (BigInt(bill.balanceMinor ?? '0') > 0n) billsUnpaid += 1;
    if (bill.currency === home) {
      billsTotal += BigInt(bill.totalMinor);
      unpaid += BigInt(bill.balanceMinor ?? '0');
    }
  }
  for (const e of co.expenses) {
    if (!(e.date >= since)) continue;
    expenses += 1;
    if (e.currency === home) expensesTotal += (e.refund ? -1n : 1n) * BigInt(e.totalMinor);
  }
  return {
    since,
    bills,
    billsUnpaid,
    expenses,
    vendors: co.vendors.length,
    activeVendors: co.vendors.filter((v) => v.active === true).length,
    accounts: co.accounts.length,
    activeAccounts: co.accounts.filter((a) => a.active === true).length,
    billsTotalUsd: dollars(billsTotal),
    expensesTotalUsd: dollars(expensesTotal),
    unpaidUsd: dollars(unpaid),
  };
}

/** The five things Decimal cannot post, found among bills in the window. */
export function recomputeCantPost(co, since) {
  const home = co.company.homeCurrency;
  const found = [];
  const bills = co.bills.filter((b) => b.date >= since);
  if (bills.some((b) => b.lines.some((l) => l.kind === 'item'))) found.push('item_lines');
  if (bills.some((b) => b.lines.some((l) => l.classId))) found.push('classes');
  if (bills.some((b) => b.locationId)) found.push('locations');
  if (bills.some((b) => b.currency !== home)) found.push('other_currency');
  if (bills.some((b) => b.lines.some((l) => l.customerId))) found.push('billable_to_customer');
  return found;
}

export function checkBooks(co, answers, today, since, fail) {
  const { company, accounts, vendors, bills, expenses } = co;
  shape('company', company, 'company', fail);
  accounts.forEach((x, i) => shape('account', x, `account[${i}]`, fail));
  vendors.forEach((x, i) => shape('vendor', x, `vendor[${i}]`, fail));
  bills.forEach((x, i) => {
    shape('bill', x, `bill[${i}]`, fail);
    (x.lines ?? []).forEach((l, k) => shape('line', l, `bill[${i}].line[${k}]`, fail));
  });
  expenses.forEach((x, i) => {
    shape('expense', x, `expense[${i}]`, fail);
    (x.lines ?? []).forEach((l, k) => shape('line', l, `expense[${i}].line[${k}]`, fail));
  });
  if (!/^\d{10,20}$/.test(company.id)) fail(`company.id ${company.id} does not look like a realm id`);

  unique(accounts, 'account', fail);
  unique(vendors, 'vendor', fail);
  const txIds = new Set();
  for (const t of [...bills, ...expenses]) {
    if (txIds.has(t.id)) fail(`transaction id ${t.id} is used by a bill and/or an expense twice`);
    txIds.add(t.id);
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  for (const a of accounts) {
    if (a.parentId !== null) {
      const parent = accountById.get(a.parentId);
      if (!parent) fail(`account ${a.id} has parent ${a.parentId} which does not exist`);
      else if (a.fullName !== `${parent.fullName}:${a.name}`) fail(`account ${a.id} fullName ${a.fullName} does not follow its parent`);
    } else if (a.fullName !== a.name) fail(`account ${a.id} has no parent but fullName differs from name`);
    if (company.accountNumbers === false && a.number !== null) fail(`account ${a.id} has a number but account numbers are off`);
  }

  const home = company.homeCurrency;
  const usedClasses = new Set();
  let usesLocations = false;
  let usesOtherCurrency = false;
  const checkLines = (t, kind) => {
    for (const [k, l] of t.lines.entries()) {
      const where = `${kind} ${t.id} line ${k}`;
      if (l.kind === 'account') {
        const acct = accountById.get(l.accountId);
        if (!acct) fail(`${where}: account ${l.accountId} does not exist`);
        else if (acct.fullName !== l.accountName) fail(`${where}: accountName ${l.accountName} is not ${acct.fullName}`);
        if (l.itemId !== null) fail(`${where}: an account line has an item`);
      } else if (l.kind === 'item') {
        if (l.itemId === null || l.itemName === null) fail(`${where}: an item line without an item`);
        if (l.accountId !== null) fail(`${where}: an item line with an account`);
      } else if (l.accountId !== null || l.itemId !== null || l.classId !== null || l.customerId !== null) {
        fail(`${where}: an 'other' line should carry no account, item, class or customer`);
      }
      if (l.classId !== null) usedClasses.add(l.classId);
    }
    const lineSum = sum(t.lines, (l) => l.amountMinor);
    const tax = BigInt(t.taxMinor ?? '0');
    if (BigInt(t.totalMinor) !== lineSum + tax) fail(`${kind} ${t.id}: total ${t.totalMinor} is not lines ${lineSum} + tax ${tax}`);
    if (BigInt(t.totalMinor) < 0n) fail(`${kind} ${t.id}: negative total`);
    if (t.date !== null && t.date > today) fail(`${kind} ${t.id}: dated ${t.date}, after today`);
    if (t.createdAt && t.date && t.createdAt.slice(0, 10) < t.date) fail(`${kind} ${t.id}: created before its own date`);
    if (t.createdAt && t.updatedAt && t.updatedAt < t.createdAt) fail(`${kind} ${t.id}: updated before created`);
    if (t.createdAt && t.createdAt.slice(0, 10) > today) fail(`${kind} ${t.id}: created in the future`);
    if (t.locationId !== null) usesLocations = true;
    if (t.currency !== home) usesOtherCurrency = true;
  };

  const owed = new Map();
  for (const b of bills) {
    checkLines(b, 'bill');
    const vendor = vendorById.get(b.vendorId);
    if (!vendor) fail(`bill ${b.id}: vendor ${b.vendorId} does not exist`);
    else {
      if (vendor.name !== b.vendorName) fail(`bill ${b.id}: vendorName ${b.vendorName} is not ${vendor.name}`);
      if (vendor.currency !== b.currency) fail(`bill ${b.id}: currency ${b.currency} but vendor is ${vendor.currency}`);
      owed.set(b.vendorId, (owed.get(b.vendorId) ?? 0n) + BigInt(b.balanceMinor ?? '0'));
    }
    const ap = accountById.get(b.payableAccountId);
    if (!ap || ap.type !== 'Accounts Payable') fail(`bill ${b.id}: payable account ${b.payableAccountId} is not an Accounts Payable account`);
    else if ((ap.currency ?? home) !== b.currency) fail(`bill ${b.id}: payable account is in ${ap.currency} but the bill is in ${b.currency}`);
    const balance = BigInt(b.balanceMinor ?? '0');
    if (balance < 0n || balance > BigInt(b.totalMinor)) fail(`bill ${b.id}: balance ${b.balanceMinor} outside 0..${b.totalMinor}`);
    if (b.dueDate !== null && b.date !== null && b.dueDate < b.date) fail(`bill ${b.id}: due before it is dated`);
    if (b.date !== null && b.date < since && balance > 0n) fail(`bill ${b.id}: unpaid but older than the window`);
  }
  for (const v of vendors) {
    const expected = owed.get(v.id) ?? 0n;
    if (BigInt(v.balanceMinor ?? '0') !== expected) fail(`vendor ${v.id}: balance ${v.balanceMinor} but its bills owe ${expected}`);
  }

  for (const e of expenses) {
    checkLines(e, 'expense');
    if (e.payeeType === null) {
      if (e.payeeId !== null || e.payeeName !== null) fail(`expense ${e.id}: payee fields without a type`);
    } else if (e.payeeType === 'Vendor') {
      const vendor = vendorById.get(e.payeeId);
      if (!vendor) fail(`expense ${e.id}: payee vendor ${e.payeeId} does not exist`);
      else if (vendor.name !== e.payeeName) fail(`expense ${e.id}: payeeName ${e.payeeName} is not ${vendor.name}`);
    } else if (!['Employee', 'Customer'].includes(e.payeeType) || e.payeeId === null || e.payeeName === null) {
      fail(`expense ${e.id}: odd payee ${e.payeeType}/${e.payeeId}`);
    }
    const from = accountById.get(e.paidFromAccountId);
    if (!from) fail(`expense ${e.id}: paid from account ${e.paidFromAccountId} does not exist`);
    else if (from.fullName !== e.paidFromAccountName) fail(`expense ${e.id}: paidFromAccountName is not ${from.fullName}`);
    if (e.locationId !== null || e.lines.some((l) => l.classId || l.customerId || l.kind === 'item') || e.currency !== home) {
      fail(`expense ${e.id}: carries a class, terminal, customer, item or foreign currency, which the answer key does not cover`);
    }
  }

  // Company switches agree with what the books use.
  if (usedClasses.size > 0 && company.classes === 'off') fail('classes are used but company.classes is off');
  if (usesLocations && !company.locations) fail('locations are used but company.locations is false');
  if (usesLocations && !company.locationLabel) fail('locations are used but there is no locationLabel');
  if (usesOtherCurrency && !company.multiCurrency) fail('another currency is used but company.multiCurrency is false');

  // The numbers.
  const facts = recomputeFacts(co, since);
  if (answers.facts.since !== since) fail(`facts.since is ${answers.facts.since}, not ${since}`);
  for (const key of Object.keys(facts)) {
    if (answers.facts[key] !== facts[key]) fail(`facts.${key} says ${JSON.stringify(answers.facts[key])}, the data says ${JSON.stringify(facts[key])}`);
  }
  for (const key of Object.keys(answers.facts)) if (!(key in facts)) fail(`facts.${key} is not a known fact`);
  const cant = recomputeCantPost(co, since);
  const stated = [...answers.cantPost].sort().join(',');
  if (stated !== [...cant].sort().join(',')) fail(`cantPost says [${answers.cantPost}], the window holds [${cant}]`);
}
