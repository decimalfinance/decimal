// The books a bill posts to, as the posting needs them: QuickBooks or Xero behind one
// shape. account-sync.ts decides when a bill posts and what it says; each system says
// how, in its own API's terms: QuickBooks here, the posting it always had (sync.ts)
// wrapped so nothing it sends or says changes, and Xero in xero-books.ts.

import type { BooksReader } from '../integrations/books.js';
import { isDate } from '../integrations/copy.js';
import { quickBooksReader } from '../integrations/quickbooks-reader.js';
import type { SetupOutcome } from '../integrations/setup/outcome.js';
import { faultOf, plainQboReason, QboError, type QuickBooks } from './quickbooks.js';
import { postBillToQuickBooks, recordedCents, type PostedBill, type SyncablePayment } from './sync.js';
import type { VendorMatch } from './vendor-match.js';

export type InvoiceFile = { fileName: string; contentType: string; bytes: Buffer };

/** What the books say a posted bill comes to now. `shownAs`: how a person finds it there. */
export type BillInBooks = { cents: bigint | null; balance: number | null; shownAs: string | null };

/** The bill isn't in the books any more: deleted, or voided, there. */
export class BillGone extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillGone';
  }
}

/**
 * The bill went into the books, and reading it back failed. It is there, so it is
 * recorded as posted to that bill and never sent again; a retry reads it back.
 */
export class PostedUnchecked extends Error {
  constructor(public readonly vendorId: string, public readonly billId: string, message: string) {
    super(message);
    this.name = 'PostedUnchecked';
  }
}

export type Books = {
  system: string;
  /** How a person names it. */
  label: string;
  companyId: string;
  reader: BooksReader;
  /**
   * A send whose answer never came may have landed. Xero's are sent again with the same
   * key, which brings back the bill that landed rather than making a second.
   * QuickBooks dedupes on its own request id, whatever happened.
   */
  replaysSends: boolean;
  /** The vendor in the books by this exact name, found without making one. Null: none, or the posting finds it itself. */
  vendorNamed(name: string): Promise<VendorMatch>;
  /** The date the books are closed through: the system's own when it keeps one, else what setup was told. */
  closedThrough(outcome: SetupOutcome | null): Promise<string | null>;
  /** Throws BillGone when it has been deleted or voided there. */
  readBack(billId: string): Promise<BillInBooks>;
  /** `key`: the send's own, for a system that replays sends. */
  post(payment: SyncablePayment, key: string): Promise<PostedBill>;
  /** The invoice's file on the bill. Its id there. */
  attach(billId: string, file: InvoiceFile): Promise<string>;
  /** Whether a send that failed this way may have landed all the same. */
  mayHaveLanded(error: unknown): boolean;
  /** A failure, in words a person can act on. */
  plainReason(error: unknown): string;
};

/** QuickBooks' own date the books are closed through, when it shares one: that moves as they close each month. */
async function quickBooksClosedThrough(qb: QuickBooks, outcome: SetupOutcome | null): Promise<string | null> {
  const answer = await qb.query('SELECT * FROM Preferences').catch(() => null);
  const live = answer?.QueryResponse?.Preferences?.[0]?.AccountingInfoPrefs?.BookCloseDate;
  const date = typeof live === 'string' ? live.slice(0, 10) : null;
  return date && isDate(date) ? date : outcome?.closingDate ?? null;
}

export function quickBooksBooks(qb: QuickBooks, apAccountId: string | null): Books {
  return {
    system: 'quickbooks',
    label: 'QuickBooks',
    companyId: qb.realmId,
    reader: quickBooksReader(qb),
    replaysSends: false,
    // Found, or made, while posting (sync.ts).
    vendorNamed: async () => null,
    closedThrough: (outcome) => quickBooksClosedThrough(qb, outcome),
    readBack: async (billId) => {
      try {
        const after = (await qb.readEntity('bill', billId)).Bill;
        return { cents: recordedCents(after), balance: Number(after.Balance), shownAs: billId };
      } catch (error) {
        if (error instanceof QboError && faultOf(error.body)?.code === '610') throw new BillGone(plainQboReason(error));
        throw error;
      }
    },
    post: (payment) => postBillToQuickBooks(qb, payment, { apAccountId }),
    attach: (billId, file) => qb.uploadAttachment({ type: 'Bill', id: billId }, file),
    mayHaveLanded: () => false,
    plainReason: plainQboReason,
  };
}
