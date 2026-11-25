// Three small companies about whether the student can start at all, and where the
// books are locked.
//   pounds       - a UK company on GBP: Decimal needs USD, so the student must stop
//   lapsed       - a USD company whose QuickBooks subscription is cancelled: also must stop
//   closed-books - a working company that has closed its books a few months back

import { Books } from './books.mjs';
import { makeCtx } from './ctx.mjs';
import { Rng, addMonths } from './util.mjs';
import { compactChart } from './charts.mjs';
import { addVendors, plainAnswers } from './small-common.mjs';
import { endOfMonthBack } from './facts.mjs';

const base = { fiscalYearStartMonth: 'January', closingDate: null, multiCurrency: false, salesTax: false, accountNumbers: false, classes: 'off', locations: false, locationLabel: null };

export function buildPounds(today) {
  const id = 'pounds';
  const b = new Books({
    id: '9341452260171843', rng: new Rng(id), today,
    company: { ...base, name: 'Hartwell & Finch Ltd', country: 'GB', homeCurrency: 'GBP', plan: 'QuickBooks Online Essentials', subscriptionStatus: 'ACTIVE', fiscalYearStartMonth: 'April', industry: 'Wholesale Distribution', salesTax: true },
  });
  compactChart(b, {
    bank: 'Business Current Account', card: 'Business Mastercard',
    names: { util: 'Light, Heat and Power', legal: 'Professional Fees', rent: 'Rent', office: 'Office Costs', insurance: 'Insurance', travel: 'Travel and Subsistence' },
  });
  const uk = (street, town, post, phone) => ({ address: `${street}, ${town}, ${post}, United Kingdom`, phone });
  addVendors(b, today, [
    ['pennine', 'Pennine Office Supplies Ltd', 'memphis', { ...uk('12 High Street', 'Leeds', 'LS1 4AB', '0113 496 0123'), dom: 'pennineoffice.co.uk', created: 30, terms: '3' }],
    ['thames', 'Thames Valley Insurance Brokers', 'memphis', { ...uk('4 Station Road', 'Reading', 'RG1 1LX', '0118 496 0177'), dom: 'tvibrokers.co.uk', created: 30, terms: '3' }],
    ['northernlights', 'Northern Lights Energy', 'memphis', { ...uk('Unit 7 Trafford Park', 'Manchester', 'M17 1PA', '0161 496 0145'), dom: 'northernlightsenergy.co.uk', created: 30, terms: '2' }],
    ['mersey', 'Mersey Haulage Ltd', 'memphis', { ...uk('Dock Road', 'Liverpool', 'L3 4BH', '0151 496 0188'), dom: 'merseyhaulage.co.uk', created: 28, terms: '3' }],
    ['clarke', 'Clarke & Dunn Accountants', 'memphis', { ...uk('21 Queen Square', 'Bristol', 'BS1 4NT', '0117 496 0102'), dom: 'clarkedunn.co.uk', created: 30, terms: '3' }],
    ['brightwave', 'Brightwave Broadband', 'memphis', { ...uk('1 Canary Wharf', 'London', 'E14 5AB', '020 7946 0191'), dom: 'brightwave.co.uk', created: 30, terms: '2' }],
  ]);
  const ctx = makeCtx(b, today);
  const vat = (lines) => (lines.reduce((s, l) => s + l.amount, 0n) * 20n + 50n) / 100n;
  const withVat = (acct, median, text) => {
    const lines = [ctx.L(acct, ctx.money(median, 0.25), text, { tax: '20.0% S' })];
    return { lines, tax: vat(lines) };
  };

  ctx.every('pennine', 3, 11, 0, 10, () => withVat('office', 180, 'Stationery and printer supplies'));
  ctx.every('thames', 3, 11, 0, 4, () => ({ lines: [ctx.L('insurance', ctx.usd(745), 'Commercial insurance instalment', { tax: 'Exempt' })] }));
  ctx.every('northernlights', 2, 11, 0, 20, () => withVat('util', 410, 'Electricity and gas'));
  ctx.scatter(6, 11, 0, () => ({ vendor: 'mersey', ...withVat('misc', 920, 'Pallet delivery') }));
  ctx.every('clarke', 3, 11, 0, 26, () => withVat('legal', 650, 'Quarterly accounts and VAT return'));
  for (let m = 9; m >= 0; m -= 1) {
    b.expense({ date: ctx.at(m, 15), payee: 'brightwave', from: 'chk', paymentType: 'Cash', lines: [ctx.L('util', ctx.usd(54), 'Broadband', { tax: '20.0% S' })] });
  }

  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = plainAnswers({
    id, fixture, since, canWork: false,
    blockingReason: "The company's home currency is GBP (United Kingdom). Decimal only works with companies whose home currency is USD, so nothing can be set up from these books.",
    person: {
      name: 'Oliver',
      role: 'Finance director of a UK wholesaler; keeps the books in pounds sterling',
      closingDate: null,
      knows: [
        'We are a UK company and keep our books in pounds sterling. We have no US dollar books.',
        'We charge and pay VAT; our financial year starts in April.',
        'I have not closed the books.',
      ],
    },
  });
  return { fixture, answers };
}

export function buildLapsed(today) {
  const id = 'lapsed';
  const b = new Books({
    id: '4620816380087341', rng: new Rng(id), today,
    company: { ...base, name: 'Redfern Plumbing & Heating, Inc.', country: 'US', homeCurrency: 'USD', plan: 'QuickBooks Online Essentials', subscriptionStatus: 'CANCELLED', industry: 'Plumbing and HVAC' },
  });
  compactChart(b, { card: 'Business Visa 2290' });
  addVendors(b, today, [
    ['alliedpipe', 'Allied Pipe & Supply', 'denver', { dom: 'alliedpipe.com', created: 40, terms: '3' }],
    ['brookline', 'Brookline Water Heaters', 'denver', { dom: 'brooklinewh.com', created: 40, terms: '3' }],
    ['summitfuel', 'Summit Fleet Fuel', 'denver', { dom: 'summitfleetfuel.com', created: 38, terms: '2' }],
    ['mutualtrade', 'Mutual Trade Insurance', 'denver', { dom: 'mutualtrade.com', created: 38, terms: '3' }],
    ['cascadetool', 'Cascade Tool Rental', 'denver', { dom: 'cascadetool.com', created: 36, terms: '3' }],
    ['redwoodbin', 'Redwood Dumpster Service', 'denver', { dom: 'redwooddumpster.com', created: 36, terms: '1' }],
  ]);
  const ctx = makeCtx(b, today);
  const { rng } = ctx;
  // They stopped using QuickBooks 14 months ago, when the subscription lapsed.
  ctx.scatter(9, 26, 14, () => ({ vendor: 'alliedpipe', lines: [ctx.L('supplies', ctx.money(640, 0.4), 'Pipe, fittings and fixtures')] }));
  ctx.scatter(4, 26, 14, () => ({ vendor: 'brookline', lines: [ctx.L('supplies', ctx.money(1180, 0.3), 'Water heater units')] }));
  ctx.every('summitfuel', 2, 26, 14, 8, () => ({ lines: [ctx.L('auto', ctx.money(1450, 0.2), 'Fleet fuel')] }));
  ctx.every('mutualtrade', 3, 26, 14, 15, () => ({ lines: [ctx.L('insurance', ctx.usd(980), 'Contractor liability premium')] }));
  ctx.scatter(3, 26, 14, () => ({ vendor: 'cascadetool', lines: [ctx.L('repairs', ctx.money(310, 0.3), 'Pipe machine rental')] }));
  ctx.scatter(3, 26, 14, () => ({ vendor: 'redwoodbin', lines: [ctx.L('util', ctx.money(420, 0.15), 'Dumpster haul')] }));
  for (let i = 0; i < 10; i += 1) {
    b.expense({ date: ctx.anyDay(rng.int(14, 26)), payee: null, from: 'card', lines: [ctx.L('auto', ctx.money(88, 0.3), 'Fuel')] });
  }
  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = plainAnswers({
    id, fixture, since, canWork: false,
    blockingReason: 'The QuickBooks subscription is cancelled (subscriptionStatus CANCELLED), so the books cannot be used for new work and the connection should not be relied on.',
    person: {
      name: 'Greg',
      role: 'Owner of a small plumbing company; cancelled QuickBooks about a year ago and now keeps a spreadsheet',
      closingDate: null,
      knows: [
        'I cancelled the QuickBooks subscription about 14 months ago. The file still opens to read, but I have not kept it up since.',
        'The books stop when I cancelled; anything newer is in my spreadsheet.',
        'I never closed the books.',
      ],
    },
  });
  return { fixture, answers };
}

export function buildClosedBooks(today) {
  const id = 'closed-books';
  const closing = endOfMonthBack(today, 4);
  const b = new Books({
    id: '9130358690044127', rng: new Rng(id), today,
    company: { ...base, name: 'Maple & Main Bakery LLC', country: 'US', homeCurrency: 'USD', plan: 'QuickBooks Online Plus', subscriptionStatus: 'ACTIVE', industry: 'Bakery and Food Service', closingDate: closing },
  });
  compactChart(b, { card: 'Business Visa 5503' });
  addVendors(b, today, [
    ['heartland', 'Heartland Flour Mills', 'minneapolis', { dom: 'heartlandflour.com', created: 36, terms: '3' }],
    ['dairy', 'Dairy Valley Co-op', 'minneapolis', { dom: 'dairyvalley.coop', created: 36, terms: '2' }],
    ['crown', 'Crown Packaging Supply', 'minneapolis', { dom: 'crownpackaging.com', created: 34, terms: '3' }],
    ['maple', 'Maple Street Realty', 'minneapolis', { dom: 'maplestreetrealty.com', created: 36, terms: '1' }],
    ['citywide', 'Citywide Utilities', 'minneapolis', { dom: 'citywideutilities.com', created: 36, terms: '2' }],
    ['freshfields', 'Fresh Fields Produce', 'minneapolis', { dom: 'freshfieldsproduce.com', created: 30, terms: '2' }],
    ['ember', 'Ember Equipment Service', 'minneapolis', { dom: 'emberequipment.com', created: 30, terms: '3' }],
    ['pinecone', 'Pinecone Insurance', 'minneapolis', { dom: 'pineconeinsurance.com', created: 36, terms: '3' }],
  ]);
  const ctx = makeCtx(b, today);
  ctx.scatter(14, 11, 0, () => ({ vendor: 'heartland', lines: [ctx.L('cogs', ctx.money(1250, 0.25), 'Flour and baking ingredients')] }));
  ctx.scatter(12, 11, 0, () => ({ vendor: 'dairy', lines: [ctx.L('cogs', ctx.money(840, 0.25), 'Milk, butter and cream')] }));
  ctx.scatter(5, 11, 0, () => ({ vendor: 'crown', lines: [ctx.L('supplies', ctx.money(390, 0.3), 'Boxes and bags')] }));
  ctx.monthly('maple', 11, 0, 1, () => ({ lines: [ctx.L('rent', ctx.usd(3150), 'Monthly rent - 214 Main St')] }), 0);
  ctx.monthly('citywide', 11, 0, 20, () => ({ lines: [ctx.L('util', ctx.money(540, 0.25), 'Gas and electric')] }));
  ctx.scatter(10, 11, 0, () => ({ vendor: 'freshfields', lines: [ctx.L('cogs', ctx.money(460, 0.3), 'Fruit and produce')] }));
  ctx.scatter(3, 11, 0, () => ({ vendor: 'ember', lines: [ctx.L('repairs', ctx.money(520, 0.3), 'Oven servicing')] }));
  ctx.every('pinecone', 3, 11, 0, 5, () => ({ lines: [ctx.L('insurance', ctx.usd(870), 'Business owner policy premium')] }));
  for (let m = 11; m >= 0; m -= 1) {
    b.expense({ date: ctx.at(m, 27), payee: null, from: 'card', lines: [ctx.L('bank', ctx.money(96, 0.2), 'Card processing fees')] });
    if (m % 2 === 0) b.expense({ date: ctx.at(m, 14), payee: null, from: 'card', lines: [ctx.L('advert', ctx.money(150, 0.2), 'Social media ads')] });
  }
  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = plainAnswers({
    id, fixture, since, canWork: true,
    person: {
      name: 'Nadia',
      role: 'Part-time controller for a neighbourhood bakery',
      closingDate: closing,
      knows: [
        `We closed the books through ${closing}. Nothing dated on or before that date should change, and it has all been reconciled.`,
        'Everything dated after the closing date is still open and is being entered as it comes in.',
        'There are eight vendors and each is a separate company, coded the same way every time.',
        'Nothing is wrong with these books apart from the lock: the closing date is the only thing to respect.',
      ],
    },
  });
  return { fixture, answers };
}
