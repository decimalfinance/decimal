// The push: a settled payment -> QBO Bill + BillPayment (from the clearing
// account), idempotent via requestid. Uses the org's configured account map so
// the operator controls which GL accounts get posted to.

import { QuickBooks, qboLiteral } from './quickbooks.js';

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
}

export interface SyncResult {
  vendorId: string;
  billId: string;
  billPaymentId: string;
  billBalance: number;
}

export async function syncPaymentToQuickBooks(
  qb: QuickBooks,
  payment: SyncablePayment,
  accounts: AccountMap,
): Promise<SyncResult> {
  // QBO holds money at 2-decimal (cent) precision and stores DisplayName trimmed,
  // control-char-free, and <=100 chars. Normalize once so the Bill, the
  // BillPayment, and any re-sync vendor lookup all agree with what QBO records —
  // otherwise a 6-decimal USDC amount drifts on rounding, or a name QBO would
  // reject/trim fails the sync or creates a near-duplicate vendor.
  const amount = Math.round(payment.amountUsdc * 100) / 100;
  const vendorLabel = Array.from(payment.vendorLabel, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 100);

  // Vendor: find or create by DisplayName (no upsert in QBO — query then create).
  let vendor = (await qb.query(`SELECT * FROM Vendor WHERE DisplayName = '${qboLiteral(vendorLabel)}'`))
    .QueryResponse?.Vendor?.[0];
  if (!vendor) {
    vendor = (await qb.createVendor({ DisplayName: vendorLabel })).Vendor;
  }

  const reference = payment.invoiceNumber ?? payment.reference ?? null;

  // One Bill line per coded line (account + amount + description); otherwise a single
  // line on the default expense account. All amounts at 2dp.
  const billLines =
    payment.codedLines && payment.codedLines.length > 0
      ? payment.codedLines.map((l) => ({
          Amount: Math.round((Number(l.amount) || 0) * 100) / 100,
          DetailType: 'AccountBasedExpenseLineDetail',
          ...(l.description ? { Description: String(l.description).slice(0, 4000) } : {}),
          AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId } },
        }))
      : [
          {
            Amount: amount,
            DetailType: 'AccountBasedExpenseLineDetail',
            AccountBasedExpenseLineDetail: { AccountRef: { value: accounts.defaultExpenseAccountId } },
          },
        ];
  const billTotal = Math.round(billLines.reduce((sum, l) => sum + Number(l.Amount), 0) * 100) / 100;

  // Bill (idempotent via requestid). APAccountRef optional — QBO defaults if omitted.
  const billBody: Record<string, unknown> = {
    VendorRef: { value: vendor.Id },
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

  const bill = (await qb.createBill(billBody, `${payment.id}_bill`)).Bill;

  // BillPayment from the clearing account, linked to the Bill.
  const billPayment = (
    await qb.createBillPayment(
      {
        VendorRef: { value: vendor.Id },
        PayType: 'Check',
        TotalAmt: billTotal,
        CheckPayment: { BankAccountRef: { value: accounts.clearingAccountId } },
        PrivateNote: `USDC settlement${payment.txSignature ? ` | sig ${payment.txSignature}` : ''}`,
        Line: [{ Amount: billTotal, LinkedTxn: [{ TxnId: bill.Id, TxnType: 'Bill' }] }],
      },
      `${payment.id}_pmt`,
    )
  ).BillPayment;

  const after = (await qb.readEntity('bill', bill.Id)).Bill;

  return {
    vendorId: vendor.Id,
    billId: bill.Id,
    billPaymentId: billPayment.Id,
    billBalance: Number(after.Balance),
  };
}
