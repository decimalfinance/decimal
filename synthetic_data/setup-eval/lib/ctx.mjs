// Helpers the company generators share: dates relative to the generation date,
// money, invoice numbers, descriptions, and the two bill rhythms (every month,
// or scattered over a span of months).

import { addDays, businessDay, cents, dayOfMonthAgo, addMonths, weekday } from './util.mjs';

export const LANES = [
  ['Memphis TN', 'Atlanta GA'], ['Atlanta GA', 'Memphis TN'], ['Memphis TN', 'Dallas TX'], ['Dallas TX', 'Memphis TN'],
  ['Columbus OH', 'Chicago IL'], ['Chicago IL', 'Columbus OH'], ['Louisville KY', 'Nashville TN'], ['Nashville TN', 'Louisville KY'],
  ['Memphis TN', 'St. Louis MO'], ['St. Louis MO', 'Kansas City MO'], ['Kansas City MO', 'Oklahoma City OK'], ['Dallas TX', 'Houston TX'],
  ['Atlanta GA', 'Savannah GA'], ['Indianapolis IN', 'Columbus OH'], ['Little Rock AR', 'Memphis TN'], ['Birmingham AL', 'Memphis TN'],
  ['Jackson MS', 'Memphis TN'], ['Cincinnati OH', 'Pittsburgh PA'], ['Memphis TN', 'Birmingham AL'], ['Oklahoma City OK', 'Dallas TX'],
];

const VAGUE = ['services', 'Services', 'misc', 'Misc.', 'other', 'charges', 'per invoice', 'see attached', 'Invoice', 'work performed'];

export function makeCtx(b, today) {
  const rng = b.rng;
  const since = addMonths(today, -24);
  const counters = new Map();

  const ctx = {
    b, rng, today, since,

    /** A business day in the month `m` months back. */
    at(m, dom) {
      return businessDay(dayOfMonthAgo(today, m, dom));
    },

    /** A random business day in that month. */
    anyDay(m) {
      return businessDay(dayOfMonthAgo(today, m, rng.int(1, 28)));
    },

    inWindow: (date) => date >= since,

    /** Whole calendar months between the date's month and this month. */
    ageMonths(date) {
      const [y, m] = date.split('-').map(Number);
      const [ty, tm] = today.split('-').map(Number);
      return ty * 12 + tm - (y * 12 + m);
    },

    /**
     * Re-enter some of a vendor's bills against a second record of the same vendor, the way
     * a duplicate gets used: the invoice numbers stay in the vendor's own series.
     */
    moveSome(bills, to, count, when) {
      const target = b.vend(to);
      const chosen = rng.shuffle(bills.filter((x) => when(ctx.ageMonths(x.date)))).slice(0, count);
      for (const x of chosen) x.vendor = target;
      return chosen;
    },

    usd: (dollars) => cents(dollars),

    /** A log-normal amount around `median`, to the cent. */
    money: (median, sigma = 0.3) => cents(rng.spread(median, sigma)),

    /** An invoice number that climbs with every call for the same vendor. */
    num(key) {
      let c = counters.get(key);
      if (!c) {
        const style = rng.int(0, 3);
        c = { style, n: rng.int(1000, 9000), tag: key.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() };
        counters.set(key, c);
      }
      c.n += rng.int(1, 6);
      return c.style === 0 ? `INV-${c.n}` : c.style === 1 ? String(c.n) : c.style === 2 ? `${c.tag}-${c.n}` : `${c.n}-${rng.int(10, 99)}`;
    },

    /** Mostly the text given; sometimes nothing, sometimes a vague word. Always draws the same numbers. */
    vague(text, p = 0.1) {
      const r = rng.next();
      const word = rng.pick(VAGUE);
      if (r < p * 0.45) return null;
      if (r < p) return word;
      return text;
    },

    load(label = 'Load') {
      const [from, to] = rng.pick(LANES);
      return `${label} ${rng.int(41000, 58999)} - ${from} to ${to}`;
    },

    /** "week ending 3/14": the Friday on or before the date. */
    weekEnding(date) {
      const back = (weekday(date) + 2) % 7;
      const friday = addDays(date, -back);
      return `week ending ${Number(friday.slice(5, 7))}/${Number(friday.slice(8, 10))}`;
    },

    L(acct, amount, desc, o = {}) {
      return b.line({ acct, amount, desc, ...o });
    },

    bill(vendor, date, lines, o = {}) {
      return b.bill({ ...o, vendor, date, lines, number: o.number === undefined ? ctx.num(vendor) : o.number });
    },

    /** One bill every month from `from` months back to `to`, on about the same day. make(m, date, i) returns {lines, ...options}. */
    monthly(vendor, from, to, dom, make, jitter = 2) {
      const made = [];
      let i = 0;
      for (let m = from; m >= to; m -= 1) {
        const nudge = jitter ? rng.int(-1, jitter) : 0;
        const date = businessDay(addDays(dayOfMonthAgo(today, m, dom), nudge));
        const spec = make(m, date, i);
        i += 1;
        if (spec) made.push(ctx.bill(spec.vendor ?? vendor, date, spec.lines, spec));
      }
      return made;
    },

    /** One bill every `step` months (quarterly is 3). */
    every(vendor, step, from, to, dom, make) {
      const made = [];
      let i = 0;
      for (let m = from; m >= to; m -= step) {
        const date = businessDay(addDays(dayOfMonthAgo(today, m, dom), rng.int(-1, 3)));
        const spec = make(m, date, i);
        i += 1;
        if (spec) made.push(ctx.bill(spec.vendor ?? vendor, date, spec.lines, spec));
      }
      return made;
    },

    /** `n` bills at random days between `from` and `to` months back, made oldest first. make(m, date, i) returns {vendor, lines, ...options}. */
    scatter(n, from, to, make) {
      const slots = [];
      for (let i = 0; i < n; i += 1) slots.push({ m: rng.int(to, from), dom: rng.int(1, 28) });
      const dated = slots
        .map((s) => ({ ...s, date: businessDay(dayOfMonthAgo(today, s.m, s.dom)) }))
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      const made = [];
      dated.forEach((s, i) => {
        const spec = make(s.m, s.date, i);
        if (spec) made.push(ctx.bill(spec.vendor, s.date, spec.lines, spec));
      });
      return made;
    },
  };
  return ctx;
}
