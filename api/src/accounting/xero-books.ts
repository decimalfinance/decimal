// A bill posted to Xero, the way QuickBooks' posting does it (sync.ts), on Xero's API.
// A bill is an invoice of type ACCPAY, entered as awaiting payment (AUTHORISED): one
// line per Category, tax as a line of its own, so the lines come to the approved total
// (linesToPost). The supplier's invoice number goes in InvoiceNumber, which Xero's
// screen calls Reference on a bill. The vendor is a contact: the one with the bill's
// name, or a new one. An archived contact is refused in words, never made twice.
//
// Every write carries a key (Idempotency-Key): sent again with its key, a write is the
// same write. account-sync.ts sends again with the key only when the first send's
// answer never came, so a bill that landed comes back instead of a second one. When
// Xero answered, nothing was made, and the next send gets a key of its own.

import { z } from 'zod';
import { BooksReadError } from '../integrations/books.js';
import { isDate } from '../integrations/copy.js';
import type { SetupOutcome } from '../integrations/setup/outcome.js';
import type { XeroWriteClient } from '../integrations/xero-app.js';
import { XeroApiError, xeroReader } from '../integrations/xero-reader.js';
import { BillGone, PostedUnchecked, type Books } from './books-poster.js';
import { fromCents, linesToPost, PostedTotalDiffers, toCents, type PostedBill, type SyncablePayment } from './sync.js';
import { inactiveVendor, type VendorMatch } from './vendor-match.js';

const NAME_MAX = 255;
const NUMBER_MAX = 255;
/** A search that matches more contacts than this many pages is not one a bill's vendor is lost in. */
const SEARCH_PAGES = 5;
const CONTACTS_PER_PAGE = 100;

const contactSchema = z.object({ ContactID: z.string(), Name: z.string().nullish(), ContactStatus: z.string().nullish() });
const invoiceSchema = z.object({
  InvoiceID: z.string(),
  InvoiceNumber: z.string().nullish(),
  Status: z.string().nullish(),
  Total: z.number().nullish(),
  AmountDue: z.number().nullish(),
});

const present = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** A name as Xero keeps a contact's: no control characters, one space at a time, 255 at most. */
export function xeroName(name: string): string {
  return Array.from(name, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

function rowsOf<T>(answer: unknown, list: string, schema: z.ZodType<T>): T[] {
  const rows = (answer as Record<string, unknown> | null)?.[list];
  return Array.isArray(rows) ? rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  }) : [];
}

/** Why a write failed may mean it never reached Xero, or that it did and the answer was lost. */
function unanswered(error: unknown): boolean {
  if (error instanceof XeroApiError) return error.status >= 500;
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError' || (error instanceof TypeError && /fetch failed/i.test(error.message));
}

export function plainXeroReason(error: unknown): string {
  if (error instanceof XeroApiError) {
    if (error.status === 429) return 'Xero asked Decimal to slow down. It will try again by itself.';
    if (error.status >= 500) return 'Xero isn’t answering. Decimal will try again by itself.';
    return error.message;
  }
  if (unanswered(error)) return 'Xero didn’t answer in time. Decimal will try again by itself.';
  if (error instanceof BooksReadError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function xeroBooks(client: XeroWriteClient): Books {
  const reader = xeroReader(client);

  /** The contacts with exactly this name, archived ones too. Xero's search finds a name inside others, whatever its case. */
  async function contactsNamed(name: string) {
    const wanted = name.toLowerCase();
    const found: Array<z.infer<typeof contactSchema>> = [];
    for (let page = 1; page <= SEARCH_PAGES; page += 1) {
      const rows = rowsOf(await client.get('Contacts', { searchTerm: name, includeArchived: 'true', page: String(page) }), 'Contacts', contactSchema);
      found.push(...rows.filter((c) => (c.Name ?? '').trim().toLowerCase() === wanted));
      if (rows.length < CONTACTS_PER_PAGE) break;
    }
    return found;
  }

  async function vendorNamed(label: string): Promise<VendorMatch> {
    const name = xeroName(label);
    if (!name) return null;
    const same = await contactsNamed(name);
    const live = same.find((c) => (c.ContactStatus ?? 'ACTIVE') === 'ACTIVE');
    if (live) return { vendorId: live.ContactID };
    // Archived, or gone for good (GDPR): Xero keeps the name, so it can't be made again.
    if (same[0]) return { problem: inactiveVendor(same[0].Name ?? name, null, 'xero') };
    return null;
  }

  /** The bill's contact: found by name, or made. */
  async function contactFor(label: string, key: string): Promise<string> {
    const found = await vendorNamed(label);
    if (found && 'problem' in found) throw new Error(found.problem);
    if (found) return found.vendorId;
    const made = rowsOf(await client.put('Contacts', { Contacts: [{ Name: xeroName(label) }] }, `${key}_contact`), 'Contacts', contactSchema)[0];
    if (!made) throw new XeroApiError(502, 'Xero answered the new contact without it.');
    return made.ContactID;
  }

  async function readBack(billId: string) {
    const bill = rowsOf(await client.get(`Invoices/${encodeURIComponent(billId)}`), 'Invoices', invoiceSchema)[0];
    if (!bill) throw new XeroApiError(502, 'Xero answered the bill without it.');
    const shownAs = present(bill.InvoiceNumber);
    if (bill.Status === 'DELETED' || bill.Status === 'VOIDED') {
      throw new BillGone(`The bill in Xero${shownAs ? `, ${shownAs},` : ''} has been ${bill.Status === 'VOIDED' ? 'voided' : 'deleted'} there.`);
    }
    return {
      cents: typeof bill.Total === 'number' ? toCents(bill.Total) : null,
      balance: typeof bill.AmountDue === 'number' ? bill.AmountDue : null,
      shownAs,
    };
  }

  /** Each line's account, as Xero takes it: by code, the way bills are keyed in, and by id for an account without one. */
  async function accountsFor(ids: string[]) {
    const chart = new Map((await reader.accounts()).records.map((a) => [a.id, a]));
    return ids.map((id) => {
      const account = chart.get(id);
      if (!account || !account.active || account.reserved || account.type === 'BANK') {
        throw new Error('A Category on this bill is archived or deleted in Xero, or isn’t one a bill can use. Pick another Category on the bill, then retry.');
      }
      return account.number ? { AccountCode: account.number } : { AccountID: account.id };
    });
  }

  async function post(payment: SyncablePayment, key: string): Promise<PostedBill> {
    const totalCents = toCents(payment.amountUsdc);
    if (!payment.codedLines || payment.codedLines.length === 0) throw new Error('This bill has no categories to post.');
    const built = linesToPost(payment.codedLines, totalCents, payment.taxAmount ? toCents(payment.taxAmount) : null, 'Xero');
    if ('problem' in built) throw new Error(built.problem);
    // Worked out before anything is written, so a bill that can't post writes nothing.
    const accounts = await accountsFor(built.lines.map((l) => l.accountId));
    const contactId = payment.vendorId ?? await contactFor(payment.vendorLabel, key);
    const number = present(payment.docNumber) ?? present(payment.invoiceNumber);
    const date = present(payment.txnDate);
    const bill = {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      ...(number ? { InvoiceNumber: number.slice(0, NUMBER_MAX) } : {}),
      ...(date && isDate(date) ? { Date: date } : {}),
      ...(payment.dueDate && isDate(payment.dueDate) ? { DueDate: payment.dueDate } : {}),
      // Said, never left to the organisation's own currency: a bill's figures are dollars.
      CurrencyCode: 'USD',
      LineAmountTypes: 'NoTax',
      Status: 'AUTHORISED',
      LineItems: built.lines.map((l, i) => ({
        Description: l.description ?? 'No description',
        Quantity: 1,
        UnitAmount: fromCents(l.cents),
        ...accounts[i],
      })),
    };
    const made = rowsOf(await client.put('Invoices', { Invoices: [bill] }, key), 'Invoices', invoiceSchema)[0];
    if (!made) throw new XeroApiError(502, 'Xero answered the bill without it.');
    // Read it back: what Xero recorded is what counts, whatever was sent.
    let after: Awaited<ReturnType<typeof readBack>>;
    try {
      after = await readBack(made.InvoiceID);
    } catch {
      throw new PostedUnchecked(contactId, made.InvoiceID, `Posted to Xero${number ? ` as ${number}` : ''}, and Decimal couldn’t read it back to check its total. Retry to check it.`);
    }
    if (after.cents !== totalCents) throw new PostedTotalDiffers(contactId, made.InvoiceID, after.cents, totalCents, 'Xero', after.shownAs);
    return { vendorId: contactId, billId: made.InvoiceID, billTotal: fromCents(totalCents), billBalance: after.balance ?? fromCents(totalCents) };
  }

  return {
    system: 'xero',
    label: 'Xero',
    companyId: client.tenantId,
    reader,
    replaysSends: true,
    vendorNamed,
    // Xero's lock dates, when it has one: they move as the books are closed.
    closedThrough: async (outcome: SetupOutcome | null) => (await reader.closingDate().catch(() => null)) ?? outcome?.closingDate ?? null,
    readBack,
    post,
    attach: async (billId, file) => {
      const answer = await client.upload(
        `Invoices/${encodeURIComponent(billId)}/Attachments/${encodeURIComponent(file.fileName)}`,
        file.bytes,
        file.contentType,
        `decimal_file_${billId}`,
      );
      const id = rowsOf(answer, 'Attachments', z.object({ AttachmentID: z.string() }))[0]?.AttachmentID;
      if (!id) throw new XeroApiError(502, 'Xero answered the file without it.');
      return id;
    },
    mayHaveLanded: unanswered,
    plainReason: plainXeroReason,
  };
}
