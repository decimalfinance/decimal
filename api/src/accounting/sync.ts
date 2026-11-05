// The push to QuickBooks, in two moments. When a bill is APPROVED it is posted
// as a Bill (the books learn the money is owed); when it is PAID, a BillPayment
// is recorded against it from the clearing account. Both idempotent through the
// requestid. A bill paid before it was ever posted gets both at once.

import { isDate } from '../integrations/copy.js';
import { QboError, QuickBooks, faultOf, qboLiteral } from './quickbooks.js';
import { inactiveVendor, nameBeforeInactive } from './vendor-match.js';

export interface AccountMap {
  clearingAccountId: string;
  defaultExpenseAccountId: string;
  apAccountId?: string | null;
}

export interface SyncablePayment {
  /** Stable Decimal id used as the idempotency base (requestid). */
  id: string;
  /** The QBO vendor DisplayName to find-or-create. */
  vendorLabel: string;
  amountUsdc: number;
  invoiceNumber?: string | null;
  reference?: string | null;
  txSignature?: string | null;
  /** Coded lines (account + amount + description) summing to amountUsdc. One Bill line
   *  each; falls back to a single line on the default expense account when absent. */
  codedLines?: Array<{ accountId: string; amount: number; description?: string | null }>;
  /** Operator-set Bill DocNumber (QBO caps it at 21 chars). */
  docNumber?: string | null;
  /** Operator-set Bill TxnDate (YYYY-MM-DD). Defaults to QBO's "today" when absent. */
  txnDate?: string | null;
  /** When it is due (YYYY-MM-DD). Absent, QuickBooks works it out from the vendor's terms. */
  dueDate?: string | null;
  /** The tax on the bill, in dollars. Only ever a figure a person confirmed or the document printed. */
  taxAmount?: number | null;
  /** The vendor in the books, when something has already said which it is. */
  vendorId?: string | null;
}

export interface SyncResult {
  vendorId: string;
  billId: string;
  billPaymentId: string;
  billBalance: number;
}

export interface PostedBill {
  vendorId: string;
  billId: string;
  billTotal: number;
  billBalance: number;
}

/** QuickBooks has the bill, and recorded a different total. It stays there, so it can't be posted again. */
export class PostedTotalDiffers extends Error {
  constructor(public readonly vendorId: string, public readonly billId: string, recorded: bigint | null, expected: bigint) {
    super(`QuickBooks recorded this bill at ${recorded === null ? 'no total' : dollars(recorded)}, and it was approved at ${dollars(expected)}. Correct bill ${billId} in QuickBooks, then retry to check it again.`);
    this.name = 'PostedTotalDiffers';
  }
}

const toCents = (amount: number): bigint => BigInt(Math.round(amount * 100));
const fromCents = (cents: bigint): number => Number(cents) / 100;

function dollars(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const raw = (cents < 0n ? -cents : cents).toString().padStart(3, '0');
  const whole = raw.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${whole}.${raw.slice(-2)}`;
}

/** What QuickBooks says a bill came to. Null if it doesn't say. */
export function recordedCents(bill: { TotalAmt?: unknown } | null | undefined): bigint | null {
  const total = Number(bill?.TotalAmt ?? Number.NaN);
  return Number.isFinite(total) ? toCents(total) : null;
}

export type PostableLine = { accountId: string; amount: number; description?: string | null };
export type PostedLine = { accountId: string; cents: bigint; description: string | null };

/**
 * The lines a bill posts with. They have to come to what was approved: that is what
 * the team owes, so it is what the books have to say.
 *
 * Tax goes on its own line, in the category of the bill's largest line, so it stays
 * visible and the total holds. Cents lost to rounding go on the largest line. Any
 * other gap is refused rather than guessed at: nothing says where that money belongs.
 */
export function linesToPost(lines: PostableLine[], totalCents: bigint, taxCents: bigint | null): { lines: PostedLine[] } | { problem: string } {
  const posted: PostedLine[] = lines.map((l) => ({ accountId: l.accountId, cents: toCents(Number(l.amount) || 0), description: l.description ? String(l.description).slice(0, 4000) : null }));
  const sum = posted.reduce((n, l) => n + l.cents, 0n);
  const largest = posted.reduce((best, l) => (l.cents > best.cents ? l : best), posted[0]!);
  // Each amount was rounded to the cent once, so this many cents can only be rounding.
  const rounding = BigInt(posted.length);
  const within = (gap: bigint) => (gap < 0n ? -gap : gap) <= rounding;
  const gap = totalCents - sum;
  if (within(gap)) {
    // Tax printed on the bill but already inside the lines lands here too.
    largest.cents += gap;
    return { lines: posted };
  }
  const tax = taxCents !== null && taxCents > 0n ? taxCents : null;
  if (tax !== null && within(gap - tax)) {
    largest.cents += gap - tax;
    return { lines: [...posted, { accountId: largest.accountId, cents: tax, description: 'Tax' }] };
  }
  const parts = tax !== null ? 'lines and tax' : 'lines';
  return { problem: `Its ${parts} come to ${dollars(sum + (tax ?? 0n))}, and it was approved at ${dollars(totalCents)}, so QuickBooks would show the wrong amount. Send it back to correct the figures.` };
}

/**
 * Post a bill to QuickBooks: find or create the vendor, then create the Bill
 * with one line per coded line. This is the moment the books learn the money
 * is owed — when the bill is approved, not when it is paid. Idempotent through
 * the requestid, so a retry never makes a second bill.
 */
export async function postBillToQuickBooks(
  qb: QuickBooks,
  payment: SyncablePayment,
  accounts: { defaultExpenseAccountId?: string | null; apAccountId?: string | null },
): Promise<PostedBill> {
  // QBO holds money at 2-decimal (cent) precision and stores DisplayName trimmed,
  // control-char-free, without colons, and <=100 chars. Normalize once so the Bill,
  // the BillPayment, and any re-sync vendor lookup all agree with what QBO records —
  // otherwise a 6-decimal USDC amount drifts on rounding, or a name QBO would
  // reject/trim fails the sync or creates a near-duplicate vendor.
  const totalCents = toCents(payment.amountUsdc);
  const vendorLabel = Array.from(payment.vendorLabel, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === ':' ? ' ' : c))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 100);

  // One Bill line per coded line; otherwise a single line on the default expense
  // account. Worked out first, so a bill that can't post writes nothing at all.
  if ((!payment.codedLines || payment.codedLines.length === 0) && !accounts.defaultExpenseAccountId) {
    throw new Error('This bill has no categories to post, and no default expense account is set.');
  }
  const built = payment.codedLines && payment.codedLines.length > 0
    ? linesToPost(payment.codedLines, totalCents, payment.taxAmount ? toCents(payment.taxAmount) : null)
    : { lines: [{ accountId: accounts.defaultExpenseAccountId!, cents: totalCents, description: null }] };
  if ('problem' in built) throw new Error(built.problem);
  const billLines = built.lines.map((l) => ({
    Amount: fromCents(l.cents),
    DetailType: 'AccountBasedExpenseLineDetail',
    ...(l.description ? { Description: l.description } : {}),
    AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId } },
  }));

  // Vendor: the one already worked out, else the one QuickBooks has by that name, or a new one.
  const vendorId = payment.vendorId ?? await vendorInBooks(qb, vendorLabel);

  const reference = payment.invoiceNumber ?? payment.reference ?? null;

  // Bill (idempotent via requestid). APAccountRef optional — QBO defaults if omitted.
  const billBody: Record<string, unknown> = {
    VendorRef: { value: vendorId },
    PrivateNote: `Decimal ${payment.id}${reference ? ` | ${reference}` : ''}`,
    Line: billLines,
  };
  if (accounts.apAccountId) {
    billBody.APAccountRef = { value: accounts.apAccountId };
  }
  // Operator-set Bill header. DocNumber caps at 21 chars in QBO; TxnDate is YYYY-MM-DD.
  const docNumber = payment.docNumber?.trim() || payment.invoiceNumber?.trim() || null;
  if (docNumber) billBody.DocNumber = docNumber.slice(0, 21);
  if (payment.txnDate?.trim()) billBody.TxnDate = payment.txnDate.trim();
  if (payment.dueDate && isDate(payment.dueDate)) billBody.DueDate = payment.dueDate;

  const bill = (await qb.createBill(billBody, `${payment.id}_bill`)).Bill;
  // Read it back: what QuickBooks recorded is what counts, whatever was sent.
  const after = (await qb.readEntity('bill', bill.Id)).Bill;
  const recorded = recordedCents(after);
  if (recorded !== totalCents) throw new PostedTotalDiffers(vendorId, bill.Id, recorded, totalCents);
  return { vendorId, billId: bill.Id, billTotal: fromCents(totalCents), billBalance: Number(after.Balance) };
}

type QboVendor = { Id: string | number; DisplayName?: string; Active?: boolean };

/** A business that is also a customer, or someone on the payroll, gets its vendor record under this name. */
const AS_VENDOR = ' (vendor)';

/**
 * The vendor a bill names, as QuickBooks has it: found by name (QuickBooks ignores
 * case), or made. QuickBooks has no upsert, so it is a query and then a create.
 *
 * Two things in QuickBooks make a name look free when it isn't. An inactive vendor is
 * renamed "Name (deleted)", so it is looked for under that name too, and refused
 * rather than made a second time. And one name belongs to one record across
 * customers, employees and vendors, so a business that is also a customer gets
 * "Name (vendor)", the way a bookkeeper names it by hand, and is found under it after.
 */
async function vendorInBooks(qb: QuickBooks, name: string): Promise<string> {
  const found = await vendorNamed(qb, name);
  if (found) return found;
  try {
    return String((await qb.createVendor({ DisplayName: name })).Vendor.Id);
  } catch (error) {
    if (!(error instanceof QboError) || faultOf(error.body)?.code !== '6240' || !(await customerOrEmployeeNamed(qb, name))) throw error;
    const alias = `${name.slice(0, 100 - AS_VENDOR.length).trimEnd()}${AS_VENDOR}`;
    return (await vendorNamed(qb, alias)) ?? String((await qb.createVendor({ DisplayName: alias })).Vendor.Id);
  }
}

/** The vendor with this name, or null when there is none. One that is inactive is refused, in words. */
async function vendorNamed(qb: QuickBooks, name: string): Promise<string | null> {
  const exact = ((await qb.query(`SELECT * FROM Vendor WHERE DisplayName = '${qboLiteral(name)}' AND Active IN (true, false)`))
    .QueryResponse?.Vendor ?? []) as QboVendor[];
  const live = exact.find((v) => v.Active !== false);
  if (live) return String(live.Id);
  if (exact[0]) throw new Error(inactiveVendor(name, exact[0].DisplayName));
  const renamed = ((await qb.query(`SELECT * FROM Vendor WHERE DisplayName LIKE '${qboLiteral(name)} (deleted%' AND Active = false`))
    .QueryResponse?.Vendor ?? []) as QboVendor[];
  const gone = renamed.find((v) => nameBeforeInactive(v.DisplayName ?? '').toLowerCase() === name.toLowerCase());
  if (gone) throw new Error(inactiveVendor(name, gone.DisplayName));
  return null;
}

/** Whether a customer or an employee has this name, the reason QuickBooks won't give it to a vendor. */
async function customerOrEmployeeNamed(qb: QuickBooks, name: string): Promise<boolean> {
  for (const entity of ['Customer', 'Employee'] as const) {
    const rows = (await qb.query(`SELECT Id FROM ${entity} WHERE DisplayName = '${qboLiteral(name)}' AND Active IN (true, false)`))
      .QueryResponse?.[entity] ?? [];
    if (rows.length > 0) return true;
  }
  return false;
}

/**
 * Record the payment against a bill already in QuickBooks: a BillPayment from
 * the clearing account, linked to the Bill. Runs when the money actually
 * moves. Idempotent through the requestid.
 */
export async function recordBillPaymentInQuickBooks(
  qb: QuickBooks,
  payment: { id: string; vendorId: string; billId: string; total: number; txSignature?: string | null },
  clearingAccountId: string,
): Promise<{ billPaymentId: string; billBalance: number }> {
  const total = Math.round(payment.total * 100) / 100;
  const billPayment = (
    await qb.createBillPayment(
      {
        VendorRef: { value: payment.vendorId },
        PayType: 'Check',
        TotalAmt: total,
        CheckPayment: { BankAccountRef: { value: clearingAccountId } },
        PrivateNote: `USDC settlement${payment.txSignature ? ` | sig ${payment.txSignature}` : ''}`,
        Line: [{ Amount: total, LinkedTxn: [{ TxnId: payment.billId, TxnType: 'Bill' }] }],
      },
      `${payment.id}_pmt`,
    )
  ).BillPayment;
  const after = (await qb.readEntity('bill', payment.billId)).Bill;
  return { billPaymentId: billPayment.Id, billBalance: Number(after.Balance) };
}

/** Bill and payment together — for a bill that was never posted before it was paid. */
export async function syncPaymentToQuickBooks(
  qb: QuickBooks,
  payment: SyncablePayment,
  accounts: AccountMap,
): Promise<SyncResult> {
  const bill = await postBillToQuickBooks(qb, payment, accounts);
  const paid = await recordBillPaymentInQuickBooks(
    qb,
    { id: payment.id, vendorId: bill.vendorId, billId: bill.billId, total: bill.billTotal, txSignature: payment.txSignature },
    accounts.clearingAccountId,
  );
  return { vendorId: bill.vendorId, billId: bill.billId, billPaymentId: paid.billPaymentId, billBalance: paid.billBalance };
}
