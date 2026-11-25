// The charts of accounts a new QuickBooks Online company starts with, and a
// trimmed version of it for the small companies.

// key, name, type, subType
const DEFAULT = [
  ['ar', 'Accounts Receivable (A/R)', 'Accounts Receivable', 'AccountsReceivable'],
  ['inv', 'Inventory Asset', 'Other Current Asset', 'Inventory'],
  ['undep', 'Undeposited Funds', 'Other Current Asset', 'UndepositedFunds'],
  ['uncatasset', 'Uncategorized Asset', 'Other Current Asset', 'OtherCurrentAssets'],
  ['ap', 'Accounts Payable (A/P)', 'Accounts Payable', 'AccountsPayable'],
  ['payrollliab', 'Payroll Liabilities', 'Other Current Liability', 'PayrollTaxPayable'],
  ['obe', 'Opening Balance Equity', 'Equity', 'OpeningBalanceEquity'],
  ['ownerinv', "Owner's Investment", 'Equity', 'OwnersEquity'],
  ['ownerpay', "Owner's Pay & Personal Expenses", 'Equity', 'PersonalExpense'],
  ['retained', 'Retained Earnings', 'Equity', 'RetainedEarnings'],
  ['billexp', 'Billable Expense Income', 'Income', 'OtherPrimaryIncome'],
  ['discgiven', 'Discounts given', 'Income', 'DiscountsRefundsGiven'],
  ['sales', 'Sales', 'Income', 'SalesOfProductIncome'],
  ['services', 'Services', 'Income', 'ServiceFeeIncome'],
  ['uncatinc', 'Uncategorized Income', 'Income', 'ServiceFeeIncome'],
  ['cogs', 'Cost of Goods Sold', 'Cost of Goods Sold', 'SuppliesMaterialsCogs'],
  ['advert', 'Advertising & Marketing', 'Expense', 'AdvertisingPromotional'],
  ['auto', 'Automobile', 'Expense', 'Auto'],
  ['bank', 'Bank Charges & Fees', 'Expense', 'BankCharges'],
  ['contract', 'Contractors', 'Expense', 'OtherMiscellaneousServiceCost'],
  ['dues', 'Dues & Subscriptions', 'Expense', 'DuesSubscriptions'],
  ['insurance', 'Insurance', 'Expense', 'Insurance'],
  ['interest', 'Interest Paid', 'Expense', 'InterestPaid'],
  ['legal', 'Legal & Professional Services', 'Expense', 'LegalProfessionalFees'],
  ['meals', 'Meals & Entertainment', 'Expense', 'EntertainmentMeals'],
  ['office', 'Office Expenses', 'Expense', 'OfficeGeneralAdministrativeExpenses'],
  ['payroll', 'Payroll Expenses', 'Expense', 'PayrollExpenses'],
  ['rent', 'Rent or Lease', 'Expense', 'RentOrLeaseOfBuildings'],
  ['repairs', 'Repairs & Maintenance', 'Expense', 'RepairMaintenance'],
  ['supplies', 'Supplies', 'Expense', 'SuppliesMaterials'],
  ['taxes', 'Taxes & Licenses', 'Expense', 'TaxesPaid'],
  ['travel', 'Travel', 'Expense', 'Travel'],
  ['util', 'Utilities', 'Expense', 'Utilities'],
  ['misc', 'Miscellaneous', 'Expense', 'OtherMiscellaneousServiceCost'],
  ['uncatexp', 'Uncategorized Expense', 'Expense', 'OtherMiscellaneousServiceCost'],
  ['otherinc', 'Other Income', 'Other Income', 'OtherMiscellaneousIncome'],
];

const COMPACT = new Set(['ar', 'ap', 'undep', 'obe', 'retained', 'ownerpay', 'sales', 'services', 'cogs', 'advert', 'auto', 'bank', 'dues', 'insurance', 'legal', 'meals', 'office', 'rent', 'repairs', 'supplies', 'travel', 'util', 'misc', 'uncatexp']);

/** The whole starting chart: what a brand-new company file holds. No bank accounts yet. */
export function fullDefaultChart(b) {
  DEFAULT.forEach(([key, name, type, subType], i) => b.account(key, { name, type, subType, number: b.company.accountNumbers ? String(1000 + i * 10) : null }));
}

/**
 * The chart a small business ends up with: the useful part of the default, plus a
 * bank account and a card. `names` renames accounts for another country.
 */
export function compactChart(b, { card = 'Business Visa 6032', bank = 'Business Checking', names = {} } = {}) {
  b.account('chk', { name: bank, type: 'Bank', subType: 'Checking' });
  b.account('card', { name: card, type: 'Credit Card', subType: 'CreditCard' });
  for (const [key, name, type, subType] of DEFAULT) {
    if (COMPACT.has(key)) b.account(key, { name: names[key] ?? name, type, subType });
  }
}
