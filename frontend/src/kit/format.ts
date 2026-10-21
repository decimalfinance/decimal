// How figures, dates and sizes read across the new pages: "$4,820.00",
// "4 Sep 2026", "212 KB". Spelled out by hand because en-GB now prints
// "Sept", and a due date is a calendar day, not a moment in someone's zone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function usd(amount: number) {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** A calendar day stored at midnight UTC (a due date, an invoice date): "4 Sep 2026". */
export function calendarDay(value: string | Date) {
  const d = new Date(value);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Whole days a calendar day is behind today; 0 or less when it isn't. */
export function daysPast(value: string | Date, now = new Date()) {
  const d = new Date(value);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - day) / DAY_MS);
}

/** A moment, as short as it can be: "9:12" today, "28 Sep" this year, "28 Sep 2025" before. */
export function when(value: string | Date, now = new Date()) {
  const d = new Date(value);
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const dayMonth = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${d.getFullYear()}`;
}

/** How long ago, for things that just happened: "just now", "4 min ago", "2 hours ago". */
export function ago(value: string | Date, now = new Date()) {
  const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  return `on ${when(value, now)}`;
}

export function fileSize(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "Tom Whitfield" → "Tom". */
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}
