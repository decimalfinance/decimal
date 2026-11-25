// Seeded randomness, calendar arithmetic and money formatting. Nothing here reads
// the clock, the network or Math.random: the same seed and the same date always
// give the same books.

export function hashSeed(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32, with the helpers the generators need. */
export class Rng {
  constructor(seed) {
    this.s = (typeof seed === 'string' ? hashSeed(seed) : seed) | 0;
  }

  next() {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Whole number in [lo, hi]. */
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  range(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /** pairs: [[value, weight], ...] */
  weighted(pairs) {
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    let at = this.next() * total;
    for (const [value, weight] of pairs) {
      at -= weight;
      if (at < 0) return value;
    }
    return pairs[pairs.length - 1][0];
  }

  shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Roughly log-normal around a median: most values near it, a tail upwards. */
  spread(median, sigma = 0.35) {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return median * Math.exp(sigma * z);
  }
}

// ---- calendar (all dates are YYYY-MM-DD strings, UTC arithmetic) ----

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export const toDate = (s) => new Date(`${s}T00:00:00Z`);
export const fmtDate = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fmtDate(new Date(toDate(s).getTime() + n * DAY));
/** Days from a to b (positive when b is later). */
export const diffDays = (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
export const weekday = (s) => toDate(s).getUTCDay(); // 0 is Sunday
export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = toDate(s);
  return !Number.isNaN(d.getTime()) && fmtDate(d) === s;
};

export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Same day of the month n months later, clamped to the month's last day. */
export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${pad(month)}-${pad(Math.min(d, daysInMonth(year, month)))}`;
}

/** The given day of the month, `monthsAgo` calendar months before today's month. */
export function dayOfMonthAgo(today, monthsAgo, dom) {
  const first = addMonths(`${today.slice(0, 7)}-01`, -monthsAgo);
  const [y, m] = first.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(Math.min(dom, daysInMonth(y, m)))}`;
}

export function lastDayOfMonth(s) {
  const [y, m] = s.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
}

/** Saturday and Sunday slide to the Friday before or the Monday after. */
export function businessDay(s, direction = 'forward') {
  const w = weekday(s);
  if (w === 6) return addDays(s, direction === 'forward' ? 2 : -1);
  if (w === 0) return addDays(s, direction === 'forward' ? 1 : -2);
  return s;
}

/** A QuickBooks-style timestamp: the date, a time in office hours, a Pacific offset. */
export function stamp(date, rng) {
  const month = Number(date.slice(5, 7));
  const offset = month >= 3 && month <= 10 ? '-07:00' : '-08:00';
  return `${date}T${pad(rng.int(7, 17))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}${offset}`;
}

/** The date part of a QuickBooks-style timestamp. */
export const stampDate = (stampText) => stampText.slice(0, 10);

// ---- money (BigInt minor units; never floats) ----

export const cents = (dollars) => BigInt(Math.round(dollars * 100));

/** 123456n is "1,234.56". */
export function formatAmount(minor) {
  const negative = minor < 0n;
  const raw = (negative ? -minor : minor).toString().padStart(3, '0');
  const whole = raw.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${raw.slice(-2)}`;
}

export const minorText = (minor) => (minor === null || minor === undefined ? null : minor.toString());

/** A figure of dollars rounded to a "nice" billing amount (to the cent). */
export const round2 = (x) => Math.round(x * 100) / 100;
