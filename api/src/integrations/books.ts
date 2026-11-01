// What an accounting system looks like to the setup harness: one shape, read
// only. A connector turns a system's own answers into these, so nothing above it
// knows which system it is talking to.
//
// There is no write here, on purpose. A harness holding a reader cannot reach the
// books: a bill gets there through the posting code, after its own approval.

export type BooksReadFailure =
  | 'sign_in_lost' // the connection no longer works; someone has to sign in again
  | 'no_access' // signed in, but not allowed to read this
  | 'throttled' // asked too often, and waiting did not help
  | 'unavailable' // the system is down or did not answer
  | 'refused'; // the system said no for another reason; the message says what

/** A read that failed. Never an empty list: "could not read" must not look like "there are none". */
export class BooksReadError extends Error {
  constructor(public readonly kind: BooksReadFailure, message: string) {
    super(message);
    this.name = 'BooksReadError';
  }
}

/** What a read brought back, against what the system says is there. */
export interface BooksRead<T> {
  records: T[];
  /** How many the system says there are, asked separately. */
  expected: number;
  /** Expected and not brought back. Above zero the read is partial, and that has to be said. */
  missing: number;
  /** Records that came back in a shape the connector could not read. */
  problems: string[];
}

/** Ids are what to key on. Names are for showing: a system may change how it spells them. */
export interface BooksCompany {
  id: string;
  name: string;
  country: string | null;
  homeCurrency: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  fiscalYearStartMonth: string | null;
  industry: string | null;
  /** The system's own closing date, if it shares one. Null means unset or not shared: ask. */
  closingDate: string | null;
  multiCurrency: boolean;
  salesTax: boolean;
  accountNumbers: boolean;
  classes: 'off' | 'per_transaction' | 'per_line';
  locations: boolean;
  /** What this company calls its locations, when it tracks them. */
  locationLabel: string | null;
}

export interface BooksAccount {
  id: string;
  name: string;
  fullName: string;
  number: string | null;
  type: string | null;
  subType: string | null;
  group: string | null;
  parentId: string | null;
  currency: string | null;
  active: boolean;
}

export interface BooksVendor {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  accountNumber: string | null;
  currency: string | null;
  balanceMinor: bigint | null;
  termsId: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BooksLine {
  amountMinor: bigint;
  description: string | null;
  /** Coded to an account, to an item, or neither. */
  kind: 'account' | 'item' | 'other';
  accountId: string | null;
  accountName: string | null;
  itemId: string | null;
  itemName: string | null;
  classId: string | null;
  className: string | null;
  customerId: string | null;
  taxCode: string | null;
}

export interface BooksBill {
  id: string;
  number: string | null;
  vendorId: string | null;
  vendorName: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string;
  totalMinor: bigint;
  balanceMinor: bigint | null;
  taxMinor: bigint | null;
  payableAccountId: string | null;
  termsId: string | null;
  locationId: string | null;
  locationName: string | null;
  note: string | null;
  lines: BooksLine[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Money that left without a bill first: a card charge, a cheque, cash. */
export interface BooksExpense {
  id: string;
  number: string | null;
  payeeId: string | null;
  payeeName: string | null;
  payeeType: string | null;
  date: string | null;
  currency: string;
  totalMinor: bigint;
  taxMinor: bigint | null;
  paymentType: string | null;
  paidFromAccountId: string | null;
  paidFromAccountName: string | null;
  /** Money coming back, not going out. */
  refund: boolean;
  locationId: string | null;
  locationName: string | null;
  note: string | null;
  lines: BooksLine[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BooksReader {
  readonly system: string;
  readonly companyId: string;
  company(): Promise<BooksCompany>;
  /** Inactive ones included: a bill from two years ago may sit on one. */
  accounts(): Promise<BooksRead<BooksAccount>>;
  vendors(): Promise<BooksRead<BooksVendor>>;
  /** Dated on or after `since`, YYYY-MM-DD. */
  bills(since: string): Promise<BooksRead<BooksBill>>;
  expenses(since: string): Promise<BooksRead<BooksExpense>>;
}

/** A system's decimal amount as exact minor units of its currency: 0.07 USD is 7, 1000 JPY is 1000. */
export function toMinor(amount: number, currency: string): bigint {
  const [whole, fraction = ''] = Math.abs(amount).toFixed(fractionDigits(currency)).split('.');
  const minor = BigInt(`${whole}${fraction}`);
  return amount < 0 ? -minor : minor;
}

/** Minor units as a figure to show: 108007 USD is "1,080.07 USD". */
export function minorToText(minor: bigint, currency: string): string {
  const digits = fractionDigits(currency);
  const sign = minor < 0n ? '-' : '';
  const raw = (minor < 0n ? -minor : minor).toString().padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits > 0 ? `.${raw.slice(-digits)}` : '';
  return `${sign}${whole}${fraction} ${currency}`;
}

function fractionDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) return 2;
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
