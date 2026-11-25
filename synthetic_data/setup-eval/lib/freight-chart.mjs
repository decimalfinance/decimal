// messy-freight: the chart of accounts, classes, items, terminals and the
// people an expense can be paid to. Plain definitions; nothing random here.

// key, number, name, type, subType, parent key, options
const CHART = [
  ['chk', '1000', 'Operating Checking', 'Bank', 'Checking', null],
  ['sav', '1010', 'Reserve Savings', 'Bank', 'Savings', null],
  ['ar', '1100', 'Accounts Receivable (A/R)', 'Accounts Receivable', 'AccountsReceivable', null],
  ['undep', '1200', 'Undeposited Funds', 'Other Current Asset', 'UndepositedFunds', null],
  ['drvadv', '1220', 'Driver Fuel Advances', 'Other Current Asset', 'OtherCurrentAssets', null],
  ['fleet', '1500', 'Fleet', 'Fixed Asset', 'Vehicles', null],
  ['tractors', '1510', 'Tractors', 'Fixed Asset', 'Vehicles', 'fleet'],
  ['trailers', '1520', 'Trailers', 'Fixed Asset', 'Vehicles', 'fleet'],

  ['ap', '2000', 'Accounts Payable (A/P)', 'Accounts Payable', 'AccountsPayable', null],
  ['apcad', '2001', 'Accounts Payable (A/P) - CAD', 'Accounts Payable', 'AccountsPayable', null, { currency: 'CAD' }],
  ['apmxn', '2002', 'Accounts Payable (A/P) - MXN', 'Accounts Payable', 'AccountsPayable', null, { currency: 'MXN' }],
  ['visa', '2100', 'Company Visa 4821', 'Credit Card', 'CreditCard', null],
  ['payrolliab', '2200', 'Payroll Liabilities', 'Other Current Liability', 'PayrollTaxPayable', null],
  ['salestax', '2250', 'Sales Tax Payable', 'Other Current Liability', 'SalesTaxPayable', null],
  ['equiploan', '2300', 'Equipment Loans', 'Long Term Liability', 'NotesPayable', null],

  ['obe', '3000', 'Opening Balance Equity', 'Equity', 'OpeningBalanceEquity', null],
  ['retained', '3200', 'Retained Earnings', 'Equity', 'RetainedEarnings', null],

  ['freightrev', '4000', 'Freight Revenue', 'Income', 'ServiceFeeIncome', null],
  ['linehaulrev', '4010', 'Linehaul', 'Income', 'ServiceFeeIncome', 'freightrev'],
  ['brokerrev', '4100', 'Brokerage Revenue', 'Income', 'ServiceFeeIncome', null],

  ['pt', '5000', 'Purchased Transportation', 'Cost of Goods Sold', 'ShippingFreightDeliveryCos', null],
  ['ptline', '5010', 'Linehaul Carriers', 'Cost of Goods Sold', 'ShippingFreightDeliveryCos', 'pt'],
  ['ptoo', '5020', 'Owner-Operator Settlements', 'Cost of Goods Sold', 'ShippingFreightDeliveryCos', 'pt'],
  ['ptdray', '5030', 'Drayage', 'Cost of Goods Sold', 'ShippingFreightDeliveryCos', 'pt'],
  ['subcontract', '5090', 'Subcontract Labor', 'Cost of Goods Sold', 'CostOfLaborCos', null, { active: false }],
  ['fuel', '5100', 'Fuel', 'Cost of Goods Sold', 'OtherCostsOfServiceCos', null],
  ['fuelfees', '5105', 'Fuel Card Fees', 'Cost of Goods Sold', 'OtherCostsOfServiceCos', null, { active: false }],
  ['tolls', '5110', 'Tolls & Scale Fees', 'Cost of Goods Sold', 'OtherCostsOfServiceCos', null],

  ['repairs', '6000', 'Repairs & Maintenance', 'Expense', 'RepairMaintenance', null],
  ['rtractors', '6010', 'Tractors', 'Expense', 'RepairMaintenance', 'repairs'],
  ['rtrailers', '6020', 'Trailers', 'Expense', 'RepairMaintenance', 'repairs'],
  ['roldtruck', '6030', 'Truck Repairs', 'Expense', 'RepairMaintenance', 'repairs', { active: false }],
  ['tires', '6040', 'Tires & Wheels', 'Expense', 'RepairMaintenance', null],
  ['shop', '6050', 'Shop Supplies', 'Expense', 'SuppliesMaterials', null],
  ['insurance', '6100', 'Insurance', 'Expense', 'Insurance', null],
  ['insauto', '6110', 'Auto Liability', 'Expense', 'Insurance', 'insurance'],
  ['inscargo', '6120', 'Cargo Insurance', 'Expense', 'Insurance', 'insurance'],
  ['inswc', '6130', 'Workers Compensation', 'Expense', 'Insurance', 'insurance'],
  ['inshealth', '6140', 'Health Insurance', 'Expense', 'Insurance', 'insurance'],
  ['payrollexp', '6200', 'Payroll Expenses', 'Expense', 'PayrollExpenses', null],
  ['benefits', '6210', 'Employee Benefits', 'Expense', 'PayrollExpenses', 'payrollexp'],
  ['payrollfees', '6220', 'Payroll Processing Fees', 'Expense', 'PayrollExpenses', 'payrollexp'],
  ['rent', '6300', 'Rent & Lease', 'Expense', 'RentOrLeaseOfBuildings', null],
  ['termrent', '6310', 'Terminal Rent', 'Expense', 'RentOrLeaseOfBuildings', 'rent'],
  ['trailerrent', '6320', 'Trailer Rental', 'Expense', 'EquipmentRental', 'rent'],
  ['utilities', '6400', 'Utilities', 'Expense', 'Utilities', null],
  ['electric', '6410', 'Electric', 'Expense', 'Utilities', 'utilities'],
  ['janitorial', '6420', 'Janitorial & Waste', 'Expense', 'Utilities', 'utilities'],
  ['phone', '6500', 'Telephone & Internet', 'Expense', 'Utilities', null],
  ['legal', '6600', 'Legal & Professional Fees', 'Expense', 'LegalProfessionalFees', null],
  ['accounting', '6610', 'Accounting', 'Expense', 'LegalProfessionalFees', 'legal'],
  ['legalfees', '6620', 'Legal Fees', 'Expense', 'LegalProfessionalFees', 'legal'],
  ['claims', '6630', 'Cargo Claims & Settlements', 'Expense', 'OtherMiscellaneousServiceCost', null],
  ['office', '6700', 'Office Supplies', 'Expense', 'OfficeGeneralAdministrativeExpenses', null],
  ['postage', '6710', 'Postage & Delivery', 'Expense', 'OfficeGeneralAdministrativeExpenses', null],
  ['software', '6720', 'Software & Subscriptions', 'Expense', 'OfficeGeneralAdministrativeExpenses', null],
  ['olddispatch', '6725', 'Dispatch (old)', 'Expense', 'OfficeGeneralAdministrativeExpenses', 'software', { active: false }],
  ['permits', '6800', 'Licenses & Permits', 'Expense', 'TaxesPaid', null],
  ['uniforms', '6810', 'Uniforms & Safety Gear', 'Expense', 'SuppliesMaterials', null],
  ['training', '6820', 'Driver Training & Testing', 'Expense', 'OtherMiscellaneousServiceCost', null],
  ['advert', '6830', 'Advertising & Marketing', 'Expense', 'AdvertisingPromotional', null],
  ['bankfees', '6840', 'Bank Charges', 'Expense', 'BankCharges', null],
  ['meals', '6850', 'Meals & Entertainment', 'Expense', 'EntertainmentMeals', null],
  ['travel', '6860', 'Travel', 'Expense', 'Travel', null],
  ['pallets', '6870', 'Pallets & Packaging', 'Expense', 'SuppliesMaterials', null],
  ['misc', '6990', 'Miscellaneous', 'Expense', 'OtherMiscellaneousServiceCost', null],
  ['uncat', '6999', 'Uncategorized Expense', 'Expense', 'OtherMiscellaneousServiceCost', null, { active: false }],
];

export function buildChart(b) {
  for (const [key, number, name, type, subType, parent, extra = {}] of CHART) {
    b.account(key, { number, name, type, subType, parent, ...extra });
  }

  // "Class" tracking is on, per line, and used by one person on some of the bills.
  b.klass('linehaul', 'Linehaul');
  b.klass('drayage', 'Drayage');
  b.klass('brokerage', 'Brokerage');
  b.klass('admin', 'Admin');

  b.item('brakes', 'Parts:Brake Pads');
  b.item('filters', 'Parts:Filters');
  b.item('belts', 'Parts:Belts & Hoses');
  b.item('lights', 'Parts:Lighting');
  b.item('core', 'Parts:Core Charge');

  b.location('memphis', 'Memphis Terminal');
  b.location('dallas', 'Dallas Terminal');
  b.location('columbus', 'Columbus Terminal');

  b.person('great', { type: 'Customer', name: 'Great Plains Grain Co.' });
  b.person('northwind', { type: 'Customer', name: 'Northwind Foods' });
  b.person('allied', { type: 'Customer', name: 'Allied Steel Distribution' });
  b.person('dana', { type: 'Employee', name: 'Dana Whitfield' });
  b.person('luis', { type: 'Employee', name: 'Luis Ortega' });
  b.person('keisha', { type: 'Employee', name: 'Keisha Thornton' });
  b.person('brian', { type: 'Employee', name: 'Brian Pruitt' });
  b.person('tomas', { type: 'Employee', name: 'Tomas Reyes' });
}
