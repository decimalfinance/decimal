// A bill dated in a period the books have closed.
//
// QuickBooks and Xero both refuse a bill dated on or before the date the books are
// closed through, and posting looks, live, right before it posts (account-sync.ts).
// Found only then, the bill has had its whole approval chain first and sits approved
// and refused. So review says so earlier (the dated_in_closed_period flag in
// bill-flags.ts) and offers the ordinary fix: post it on the first open day. The bill
// keeps its own date, for when it is due and for spotting duplicates; only the books
// get the other, and the choice is recorded on the bill with who made it.
//
// The flag rules run for every bill on every read, so review can't look live each
// time. It uses the books' own date as last read, read again in the background once
// it is FRESH_MS old, and until a read has come back, the date agreed at setup, which
// is what posting falls back to as well.
import { trackBackgroundWork } from '../infra/background.js';
import { logger } from '../infra/logger.js';
import { connectorFor } from '../integrations/connectors.js';
import { isDate } from '../integrations/copy.js';
import { readOutcome } from '../integrations/setup/outcome.js';
import { postingTarget } from './connections.js';

export type BooksSystem = 'quickbooks' | 'xero';
export type ClosedBooks = { system: BooksSystem; closedThrough: string };

/**
 * What someone chose for a bill dated in a closed period, kept on the bill
 * (metadata.postingDate). `open_period`: the books get it dated `postOn`, the first open
 * day. `keep`: it keeps its date, for a period someone means to reopen.
 */
export type PostingDateChoice = {
  kind: 'open_period' | 'keep';
  postOn: string | null;
  /** The bill's own date when the choice was made. A changed date undoes it. */
  billDate: string;
  /** The date the books were closed through when the choice was made. */
  closedThrough: string;
  system: BooksSystem;
  byUserId: string;
  byName: string;
  reason: string | null;
  at: string;
};

const FRESH_MS = 15 * 60_000;
/** How long the first look since the API started waits for the books before going by the setup's date. */
const COLD_WAIT_MS = 2_500;
type Read = { system: BooksSystem; companyId: string; closedThrough: string | null; at: number };
const lastRead = new Map<string, Read>();
const reading = new Map<string, Promise<void>>();

/** Tests start from nothing read. */
export function forgetClosedBooksForTests() {
  lastRead.clear();
}

/**
 * The date the books this organisation posts to are closed through, as review uses it,
 * or null when it posts nowhere or the books keep no closing date. Like posting, it goes
 * by the books' own date when they give one, and otherwise by the date agreed at setup.
 */
export async function closedBooksFor(organizationId: string): Promise<ClosedBooks | null> {
  const target = await postingTarget(organizationId);
  if (!target || (target.system !== 'quickbooks' && target.system !== 'xero')) return null;
  const system: BooksSystem = target.system;
  const readNow = () => {
    const read = lastRead.get(organizationId);
    return read && read.system === system && read.companyId === target.companyId ? read : null;
  };
  let read = readNow();
  if (target.live && !(read && Date.now() - read.at < FRESH_MS)) {
    const pending = readAgain(organizationId, system, target.companyId);
    // Never read since the API started: worth a moment's wait, so the first look isn't
    // the setup's date when the books have closed another month since.
    if (!read) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, COLD_WAIT_MS); })]);
      clearTimeout(timer);
      read = readNow();
    }
  }
  const closedThrough = read?.closedThrough ?? (await readOutcome(organizationId, system, target.companyId))?.closingDate ?? null;
  return closedThrough && isDate(closedThrough) ? { system, closedThrough } : null;
}

function readAgain(organizationId: string, system: BooksSystem, companyId: string): Promise<void> {
  const running = reading.get(organizationId);
  if (running) return running;
  const work = (async () => {
    let closedThrough: string | null = null;
    try {
      const reader = await connectorFor(system).reader(organizationId);
      // Never another company's date. A reader that doesn't say which company it reads
      // is the one posting itself uses, so its date is the one posting would go by.
      if (reader && (!reader.companyId || reader.companyId === companyId)) {
        const date = (await reader.closingDate())?.slice(0, 10) ?? null;
        closedThrough = date && isDate(date) ? date : null;
      }
    } catch (error) {
      // Kept as nothing read: review goes by the setup's date, and posting looks again itself.
      logger.warn('closed_period.read_failed', { organizationId, system, ...(error instanceof Error ? { message: error.message } : {}) });
    } finally {
      lastRead.set(organizationId, { system, companyId, closedThrough, at: Date.now() });
      reading.delete(organizationId);
    }
  })();
  reading.set(organizationId, work);
  trackBackgroundWork(work);
  return work;
}

/** The day after `date`: the first day the books are open. */
export function firstOpenDay(closedThrough: string): string {
  return new Date(Date.parse(`${closedThrough}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** A bill's date as review and posting read it: YYYY-MM-DD, or null. */
export function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.trim().slice(0, 10);
  return isDate(date) ? date : null;
}

export function postingDateChoiceOf(metadata: unknown): PostingDateChoice | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).postingDate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.kind !== 'open_period' && c.kind !== 'keep') return null;
  if (c.system !== 'quickbooks' && c.system !== 'xero') return null;
  const billDate = dateOnly(c.billDate);
  const closedThrough = dateOnly(c.closedThrough);
  const postOn = dateOnly(c.postOn);
  if (!billDate || !closedThrough || (c.kind === 'open_period' && !postOn)) return null;
  return {
    kind: c.kind, postOn, billDate, closedThrough, system: c.system,
    byUserId: typeof c.byUserId === 'string' ? c.byUserId : '',
    byName: typeof c.byName === 'string' && c.byName.trim() ? c.byName : 'Someone',
    reason: typeof c.reason === 'string' ? c.reason : null,
    at: typeof c.at === 'string' ? c.at : '',
  };
}

/**
 * The date the books get for this bill: the first open day someone chose, while the
 * bill still has the date it was chosen for, otherwise the bill's own.
 */
export function postingDateFor(billDate: string | null, choice: PostingDateChoice | null): string | null {
  if (billDate && choice?.kind === 'open_period' && choice.billDate === billDate && choice.postOn) return choice.postOn;
  return billDate;
}
