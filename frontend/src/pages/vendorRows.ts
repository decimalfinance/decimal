// Vendors as both Vendors pages read them: which vendors are listed, each one's
// bills, whether it is new or on hold, its other names, and where it is. The
// list and a vendor's page share this, so they never disagree on a number.
import type { WorkbenchBill } from '../api';
import type { Counterparty, VendorPayableHold } from '../types';
import { stageOf } from './billStatus';

export type VendorAddress = NonNullable<WorkbenchBill['vendorAddress']>;

export type VendorRow = {
  vendor: Counterparty;
  /** Its bills, newest arrival first. */
  bills: WorkbenchBill[];
  hold: VendorPayableHold | null;
  /** Its first bill is its only one: the same idea as a bill's "First bill from vendor". */
  isNew: boolean;
  /** Other names its bills have arrived under. */
  aliases: string[];
  /** A vendor keeps no contact of its own; these are its newest bill's that has one. */
  email: string | null;
  address: VendorAddress | null;
};

/** The record every file nothing could be read from is filed under until someone keys it in. */
const PLACEHOLDER = 'unreadable document';
/** Closed as somebody else's, or as no bill at all: the company didn't bill us. */
const NOT_OURS = new Set(['not_ours', 'unreadable']);

/** A company with a page of its own: not a record merged into another, not the placeholder. */
export function isVendor(vendor: Counterparty) {
  return vendor.status === 'active' && vendor.displayName.trim().toLowerCase() !== PLACEHOLDER;
}

function aliasesOf(vendor: Counterparty) {
  const raw = vendor.metadataJson?.nameAliases;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [];
}

function hasAddress(address: VendorAddress | null) {
  return Boolean(address && Object.values(address).some(Boolean));
}

function rowOf(vendor: Counterparty, bills: WorkbenchBill[]): VendorRow {
  const sorted = [...bills].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return {
    vendor,
    bills: sorted,
    hold: vendor.payableHold,
    isNew: sorted.length === 1,
    aliases: aliasesOf(vendor),
    email: sorted.find((b) => b.vendorEmail)?.vendorEmail ?? null,
    address: sorted.find((b) => hasAddress(b.vendorAddress))?.vendorAddress ?? null,
  };
}

/** A vendor's bills: a file nothing was read from belongs to no company yet. */
function billsOf(counterpartyId: string, bills: WorkbenchBill[]) {
  return bills.filter((b) => b.counterpartyId === counterpartyId && !b.unreadable);
}

/** One vendor, for its page. */
export function vendorRow(vendor: Counterparty, bills: WorkbenchBill[]) {
  return rowOf(vendor, billsOf(vendor.counterpartyId, bills));
}

/** Every vendor the organisation gets bills from, A to Z. */
export function vendorRows(vendors: Counterparty[], bills: WorkbenchBill[]) {
  const byVendor = new Map<string, WorkbenchBill[]>();
  for (const bill of bills) {
    if (!bill.counterpartyId || bill.unreadable) continue;
    const list = byVendor.get(bill.counterpartyId);
    if (list) list.push(bill);
    else byVendor.set(bill.counterpartyId, [bill]);
  }
  return vendors
    .filter(isVendor)
    .map((v) => rowOf(v, byVendor.get(v.counterpartyId) ?? []))
    // A company whose every bill was closed as somebody else's isn't a vendor.
    .filter((r) => r.bills.some((b) => !NOT_OURS.has(b.closedReason ?? '')))
    .sort((a, b) => a.vendor.displayName.localeCompare(b.vendor.displayName, undefined, { sensitivity: 'base' }));
}

const HOME = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i;

/** "Tacoma, WA" at home, "Munich, Germany" abroad. */
export function locationOf(address: VendorAddress | null) {
  if (!address) return null;
  const { city, state, country } = address;
  const home = country ? HOME.test(country.trim()) : Boolean(state);
  const text = (home ? [city, state] : [city, country]).filter(Boolean).join(', ');
  return text || country || null;
}

/** The bills a hold is stopping now: still in review, so they can't be sent for approval. */
export function heldBills(row: VendorRow) {
  return row.bills.filter(
    (b) => stageOf(b) === 'review' && b.flags.some((f) => f.kind === 'vendor_held' || f.kind === 'vendor_blocked'),
  );
}

/** What a hold says when you point at it: who, when, and why, in their words. */
export function holdTitle(hold: VendorPayableHold, day: (at: string) => string) {
  const verb = hold.status === 'blocked' ? 'Blocked' : 'Held';
  return `${verb} by ${hold.byName}${hold.at ? ` on ${day(hold.at)}` : ''}: ${hold.reason}`;
}

/** The search: the vendor's name, any name its bills came under, and its email. */
export function vendorMatches(row: VendorRow, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    row.vendor.displayName.toLowerCase().includes(q)
    || row.aliases.some((a) => a.toLowerCase().includes(q))
    || (row.email ?? '').toLowerCase().includes(q)
  );
}
