// QuickBooks' standard expense chart, built in. Used whenever an org hasn't
// connected its books yet: the review screen's category picker and the intake
// coding suggestions work out of the box, and once QuickBooks IS connected the
// real chart takes over. Builtin ids are namespaced so they can never be
// mistaken for (or synced as) real QuickBooks account ids.
import type { ExpenseAccount } from './ocr-coding.js';

export const BUILTIN_ACCOUNT_PREFIX = 'builtin:';

export const DEFAULT_EXPENSE_ACCOUNTS: ExpenseAccount[] = [
  { id: 'builtin:advertising', name: 'Advertising & marketing', description: 'Ads, sponsorships, promotional materials' },
  { id: 'builtin:bank-charges', name: 'Bank charges & fees', description: 'Bank service fees, payment processing fees' },
  { id: 'builtin:contractors', name: 'Contractors', description: 'Independent contractors and outsourced work' },
  { id: 'builtin:dues', name: 'Dues & subscriptions', description: 'Software subscriptions, memberships, licenses' },
  { id: 'builtin:equipment-rental', name: 'Equipment rental', description: 'Rented machinery, devices, or equipment' },
  { id: 'builtin:insurance', name: 'Insurance', description: 'Business insurance premiums' },
  { id: 'builtin:interest', name: 'Interest paid', description: 'Interest on loans and credit' },
  { id: 'builtin:job-supplies', name: 'Job supplies', description: 'Materials and supplies for delivering work' },
  { id: 'builtin:legal-professional', name: 'Legal & professional services', description: 'Lawyers, accountants, consultants, advisors' },
  { id: 'builtin:meals', name: 'Meals & entertainment', description: 'Business meals and client entertainment' },
  { id: 'builtin:office-supplies', name: 'Office supplies & software', description: 'Office consumables, small equipment, software' },
  { id: 'builtin:payroll', name: 'Payroll expenses', description: 'Wages, salaries, benefits' },
  { id: 'builtin:rent', name: 'Rent & lease', description: 'Office or facility rent and leases' },
  { id: 'builtin:repairs', name: 'Repairs & maintenance', description: 'Upkeep of property and equipment' },
  { id: 'builtin:shipping', name: 'Shipping & delivery', description: 'Freight, postage, couriers, logistics' },
  { id: 'builtin:taxes-licenses', name: 'Taxes & licenses', description: 'Business taxes, permits, government fees' },
  { id: 'builtin:travel', name: 'Travel', description: 'Flights, lodging, ground transport' },
  { id: 'builtin:utilities', name: 'Utilities', description: 'Electricity, water, internet, phone' },
  { id: 'builtin:cloud-hosting', name: 'Cloud hosting & infrastructure', description: 'Servers, cloud compute, storage, infrastructure services' },
  { id: 'builtin:other', name: 'Other business expenses', description: 'Anything that fits nowhere else' },
  // The catch-all (GL synthesis D3/P1): the accountant's holding tank every
  // ledger already has (QBO: "Uncategorized Expense" / "Ask My Accountant").
  // Coding uncertainty parks here — it never blocks a bill.
  { id: 'builtin:uncategorized', name: 'Uncategorized expense', description: 'Parked for your accountant to place — sweep before close' },
];

export const UNCATEGORIZED_ACCOUNT = DEFAULT_EXPENSE_ACCOUNTS[DEFAULT_EXPENSE_ACCOUNTS.length - 1]!;
