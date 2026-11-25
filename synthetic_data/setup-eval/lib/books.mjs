// A small in-memory set of books: define accounts, vendors and records by key,
// then finish() assigns QuickBooks-like ids and timestamps and returns a
// BooksFixture (every *Minor field a decimal string, as the exam files hold it).
//
// Callers keep the objects these methods return. After finish() each has an `id`,
// which is how the hidden answers are written without ever typing an id by hand.

import { addDays, diffDays, stamp, stampDate, minorText } from './util.mjs';

const TERMS_DAYS = { 1: 0, 2: 15, 3: 30, 4: 60, 5: 10, 6: 45 };

const GROUP_OF_TYPE = {
  Bank: 'Asset',
  'Accounts Receivable': 'Asset',
  'Other Current Asset': 'Asset',
  'Fixed Asset': 'Asset',
  'Other Asset': 'Asset',
  'Accounts Payable': 'Liability',
  'Credit Card': 'Liability',
  'Other Current Liability': 'Liability',
  'Long Term Liability': 'Liability',
  Equity: 'Equity',
  Income: 'Revenue',
  'Other Income': 'Revenue',
  'Cost of Goods Sold': 'Expense',
  Expense: 'Expense',
  'Other Expense': 'Expense',
};

export class Books {
  constructor({ id, company, rng, today }) {
    this.rng = rng;
    this.today = today;
    this.company = {
      id,
      name: company.name,
      country: company.country ?? null,
      homeCurrency: company.homeCurrency ?? null,
      plan: company.plan ?? null,
      subscriptionStatus: company.subscriptionStatus ?? null,
      fiscalYearStartMonth: company.fiscalYearStartMonth ?? null,
      industry: company.industry ?? null,
      closingDate: company.closingDate ?? null,
      multiCurrency: company.multiCurrency ?? false,
      salesTax: company.salesTax ?? false,
      accountNumbers: company.accountNumbers ?? false,
      classes: company.classes ?? 'off',
      locations: company.locations ?? false,
      locationLabel: company.locationLabel ?? null,
    };
    this.accounts = [];
    this.vendors = [];
    this.people = [];
    this.classes = [];
    this.items = [];
    this.locations = [];
    this.bills = [];
    this.expenses = [];
    this._byKey = new Map();
    this._seq = 0;
    this._finished = false;
  }

  get home() {
    return this.company.homeCurrency ?? 'USD';
  }

  _register(kind, key, record) {
    const slot = `${kind}:${key}`;
    if (this._byKey.has(slot)) throw new Error(`duplicate ${slot}`);
    this._byKey.set(slot, record);
    record.key = key;
    return record;
  }

  _get(kind, key) {
    const record = this._byKey.get(`${kind}:${key}`);
    if (!record) throw new Error(`unknown ${kind} key: ${key}`);
    return record;
  }

  // ---- definitions ----

  account(key, spec) {
    const parent = spec.parent ? this._get('account', spec.parent) : null;
    const record = {
      id: null,
      name: spec.name,
      fullName: parent ? `${parent.fullName}:${spec.name}` : spec.name,
      number: spec.number ?? null,
      type: spec.type,
      subType: spec.subType ?? null,
      group: spec.group ?? GROUP_OF_TYPE[spec.type] ?? null,
      parent,
      currency: spec.currency ?? null,
      active: spec.active ?? true,
    };
    this.accounts.push(record);
    return this._register('account', key, record);
  }

  acct(key) {
    return this._get('account', key);
  }

  vendor(key, spec) {
    const record = {
      id: null,
      name: spec.name,
      company: spec.company === undefined ? (this.rng.chance(0.55) ? spec.name : null) : spec.company,
      email: spec.email ?? null,
      phone: spec.phone ?? null,
      address: spec.address ?? null,
      accountNumber: spec.accountNumber ?? null,
      currency: spec.currency ?? this.home,
      terms: spec.terms ?? '3',
      active: spec.active ?? true,
      created: spec.created > this.today ? this.today : spec.created,
      order: this.vendors.length,
    };
    this.vendors.push(record);
    return this._register('vendor', key, record);
  }

  vend(key) {
    return this._get('vendor', key);
  }

  /** Employees and customers: the other things an expense can be paid to. */
  person(key, spec) {
    const record = { id: null, type: spec.type, name: spec.name };
    this.people.push(record);
    return this._register('person', key, record);
  }

  klass(key, name) {
    const record = { id: null, name };
    this.classes.push(record);
    return this._register('class', key, record);
  }

  item(key, name) {
    const record = { id: null, name };
    this.items.push(record);
    return this._register('item', key, record);
  }

  location(key, name) {
    const record = { id: null, name };
    this.locations.push(record);
    return this._register('location', key, record);
  }

  // ---- records ----

  /** spec: acct | item | other, amount (BigInt cents), desc, cls, customer, tax. */
  line(spec) {
    return {
      kind: spec.item ? 'item' : spec.other ? 'other' : 'account',
      acct: spec.acct ? this.acct(spec.acct) : null,
      item: spec.item ? this._get('item', spec.item) : null,
      cls: spec.cls ? this._get('class', spec.cls) : null,
      customer: spec.customer ? this._get('person', spec.customer) : null,
      amount: spec.amount,
      desc: spec.desc ?? null,
      tax: spec.tax === undefined ? (this.company.salesTax ? 'NON' : null) : spec.tax,
    };
  }

  bill(spec) {
    const vendor = this.vend(spec.vendor);
    const terms = spec.terms ?? vendor.terms;
    const lines = spec.lines;
    const tax = spec.tax ?? null;
    const total = lines.reduce((sum, l) => sum + l.amount, 0n) + (tax ?? 0n);
    const roll = this.rng.next();
    const lagRoll = this.rng.next();
    const age = diffDays(spec.date, this.today);
    const openChance = age <= 10 ? 0.85 : age <= 25 ? 0.5 : age <= 40 ? 0.15 : 0;
    let status = spec.status ?? 'auto';
    if (status === 'auto') status = roll < openChance ? 'open' : 'paid';
    let balance = 0n;
    if (status === 'open') balance = total;
    if (status === 'partial') balance = spec.balance ?? (total * BigInt(40 + Math.floor(roll * 30))) / 100n;
    const record = {
      id: null,
      _seq: (this._seq += 1),
      kind: 'bill',
      vendor,
      number: spec.number ?? null,
      date: spec.date,
      dueDate: spec.due ?? addDays(spec.date, TERMS_DAYS[terms] ?? 30),
      currency: spec.currency ?? this.home,
      total,
      balance,
      tax,
      ap: this.acct(spec.ap ?? 'ap'),
      terms,
      location: spec.location ? this._get('location', spec.location) : null,
      note: spec.note ?? null,
      lines,
      entered: spec.entered ?? addDays(spec.date, lagRoll < 0.5 ? 0 : lagRoll < 0.75 ? 1 : lagRoll < 0.95 ? 2 + Math.floor(lagRoll * 40) % 4 : 6 + Math.floor(lagRoll * 100) % 14),
      paidOn: spec.paidOn ?? null,
    };
    this.bills.push(record);
    return record;
  }

  /** payee: a vendor or person key, or null for none. */
  expense(spec) {
    const payee = spec.payee ? (this._byKey.get(`vendor:${spec.payee}`) ?? this._get('person', spec.payee)) : null;
    const payeeType = payee ? (payee.terms !== undefined ? 'Vendor' : payee.type) : null;
    const tax = spec.tax ?? null;
    const total = spec.lines.reduce((sum, l) => sum + l.amount, 0n) + (tax ?? 0n);
    const lagRoll = this.rng.next();
    const record = {
      id: null,
      _seq: (this._seq += 1),
      kind: 'expense',
      payee,
      payeeType,
      number: spec.number ?? null,
      date: spec.date,
      currency: spec.currency ?? this.home,
      total,
      tax,
      paymentType: spec.paymentType ?? 'CreditCard',
      from: this.acct(spec.from),
      refund: spec.refund ?? false,
      location: spec.location ? this._get('location', spec.location) : null,
      note: spec.note ?? null,
      lines: spec.lines,
      entered: spec.entered ?? addDays(spec.date, lagRoll < 0.6 ? 0 : lagRoll < 0.85 ? 1 : 2 + Math.floor(lagRoll * 30) % 3),
    };
    this.expenses.push(record);
    return record;
  }

  /** Drop anything dated after today. Generators draw the same numbers either way. */
  prune() {
    this.bills = this.bills.filter((x) => x.date <= this.today);
    this.expenses = this.expenses.filter((x) => x.date <= this.today);
  }

  // ---- ids, timestamps, output ----

  /** Move a date no later than today. */
  _cap(date) {
    return date > this.today ? this.today : date;
  }

  finish() {
    if (this._finished) throw new Error('finish() twice');
    this._finished = true;
    const rng = this.rng;
    const step = (n, extra = 0.2) => n + (rng.chance(extra) ? rng.int(1, 3) : 0);

    let n = 0;
    for (const a of this.accounts) a.id = String((n = step(n + 1, 0.25)));

    // A vendor cannot be older than its first record.
    const firstEntry = new Map();
    const lastEntry = new Map();
    for (const t of [...this.bills, ...this.expenses]) {
      const who = t.kind === 'bill' ? t.vendor : t.payee && t.payeeType === 'Vendor' ? t.payee : null;
      if (!who) continue;
      const e = this._cap(t.entered);
      if (!firstEntry.has(who) || e < firstEntry.get(who)) firstEntry.set(who, e);
      if (!lastEntry.has(who) || e > lastEntry.get(who)) lastEntry.set(who, e);
    }
    for (const v of this.vendors) {
      const first = firstEntry.get(v);
      v.createdDate = first && first < v.created ? addDays(first, -rng.int(1, 6)) : v.created;
    }
    const ordered = [...this.vendors].sort((a, b) => (a.createdDate < b.createdDate ? -1 : a.createdDate > b.createdDate ? 1 : a.order - b.order));
    n = 2;
    for (const v of ordered) v.id = String((n = step(n + 1, 0.3)));

    for (const type of ['Employee', 'Customer']) {
      n = 0;
      for (const p of this.people.filter((x) => x.type === type)) p.id = String((n = step(n + 1, 0.25)));
    }
    n = 0;
    for (const c of this.classes) c.id = String((n = step(n + 1)));
    n = 10;
    for (const i of this.items) i.id = String((n = step(n + 1)));
    n = 0;
    for (const l of this.locations) l.id = String((n = step(n + 1, 0)));

    const all = [...this.bills, ...this.expenses].sort((a, b) => (a.entered < b.entered ? -1 : a.entered > b.entered ? 1 : a._seq - b._seq));
    n = 100;
    for (const t of all) t.id = String((n = step(n + 1, 0.35)));

    for (const t of all) {
      const created = this._cap(t.entered);
      t.createdAt = stamp(created, rng);
      let updated = created;
      if (t.kind === 'bill') {
        if (t.balance === 0n) {
          const wanted = t.paidOn ?? addDays(t.dueDate, rng.int(-6, 10));
          updated = wanted < created ? addDays(created, rng.int(1, 5)) : wanted;
        } else if (t.balance < t.total) {
          updated = addDays(created, rng.int(5, 25));
        }
        updated = this._cap(updated);
      }
      t.updatedAt = updated === created ? t.createdAt : stamp(updated, rng);
      if (stampDate(t.updatedAt) < stampDate(t.createdAt)) t.updatedAt = t.createdAt;
    }

    const balances = new Map();
    for (const b of this.bills) balances.set(b.vendor, (balances.get(b.vendor) ?? 0n) + b.balance);

    for (const v of this.vendors) {
      v.createdAt = stamp(v.createdDate, rng);
      const base = lastEntry.get(v) ?? v.createdDate;
      const from = base > v.createdDate ? base : v.createdDate;
      const to = this._cap(addDays(from, v.active ? rng.int(0, 150) : rng.int(10, 90)));
      v.updatedAt = to <= v.createdDate ? v.createdAt : stamp(to, rng);
      v.balance = balances.get(v) ?? 0n;
    }

    return this._fixture(ordered, all);
  }

  _lineOut(l) {
    return {
      amountMinor: minorText(l.amount),
      description: l.desc,
      kind: l.kind,
      accountId: l.acct ? l.acct.id : null,
      accountName: l.acct ? l.acct.fullName : null,
      itemId: l.item ? l.item.id : null,
      itemName: l.item ? l.item.name : null,
      classId: l.cls ? l.cls.id : null,
      className: l.cls ? l.cls.name : null,
      customerId: l.customer ? l.customer.id : null,
      taxCode: l.tax,
    };
  }

  _fixture(vendorsByCreation, transactionsById) {
    const byId = (a, b) => Number(a.id) - Number(b.id);
    return {
      company: this.company,
      accounts: this.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        fullName: a.fullName,
        number: a.number,
        type: a.type,
        subType: a.subType,
        group: a.group,
        parentId: a.parent ? a.parent.id : null,
        currency: a.currency,
        active: a.active,
      })),
      vendors: [...vendorsByCreation].sort(byId).map((v) => ({
        id: v.id,
        name: v.name,
        company: v.company,
        email: v.email,
        phone: v.phone,
        address: v.address,
        accountNumber: v.accountNumber,
        currency: v.currency,
        balanceMinor: minorText(v.balance),
        termsId: v.terms,
        active: v.active,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
      bills: transactionsById.filter((t) => t.kind === 'bill').map((b) => ({
        id: b.id,
        number: b.number,
        vendorId: b.vendor.id,
        vendorName: b.vendor.name,
        date: b.date,
        dueDate: b.dueDate,
        currency: b.currency,
        totalMinor: minorText(b.total),
        balanceMinor: minorText(b.balance),
        taxMinor: minorText(b.tax),
        payableAccountId: b.ap.id,
        termsId: b.terms,
        locationId: b.location ? b.location.id : null,
        locationName: b.location ? b.location.name : null,
        note: b.note,
        lines: b.lines.map((l) => this._lineOut(l)),
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })),
      expenses: transactionsById.filter((t) => t.kind === 'expense').map((e) => ({
        id: e.id,
        number: e.number,
        payeeId: e.payee ? e.payee.id : null,
        payeeName: e.payee ? e.payee.name : null,
        payeeType: e.payeeType,
        date: e.date,
        currency: e.currency,
        totalMinor: minorText(e.total),
        taxMinor: minorText(e.tax),
        paymentType: e.paymentType,
        paidFromAccountId: e.from.id,
        paidFromAccountName: e.from.fullName,
        refund: e.refund,
        locationId: e.location ? e.location.id : null,
        locationName: e.location ? e.location.name : null,
        note: e.note,
        lines: e.lines.map((l) => this._lineOut(l)),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  }
}
