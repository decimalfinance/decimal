// Three companies with nothing wrong in them. If the student reports a problem in
// any of these, it invented one.
//   small-clean - five vendors, forty bills, every vendor coded the same way every time
//   empty       - a brand-new company: the default chart and nothing else
//   card-only   - no bills at all; everything is a card charge, coded consistently

import { Books } from './books.mjs';
import { makeCtx } from './ctx.mjs';
import { Rng, addMonths, dayOfMonthAgo, businessDay } from './util.mjs';
import { compactChart, fullDefaultChart } from './charts.mjs';
import { addVendors, plainAnswers } from './small-common.mjs';

const company = (o) => ({
  country: 'US', homeCurrency: 'USD', subscriptionStatus: 'ACTIVE', fiscalYearStartMonth: 'January', closingDate: null,
  multiCurrency: false, salesTax: false, accountNumbers: false, classes: 'off', locations: false, locationLabel: null, ...o,
});

export function buildSmallClean(today) {
  const id = 'small-clean';
  const b = new Books({
    id: '4620816365209743', rng: new Rng(id), today,
    company: company({ name: 'Birchwood Design Studio LLC', plan: 'QuickBooks Online Simple Start', industry: 'Interior Design' }),
  });
  compactChart(b);
  addVendors(b, today, [
    ['parkside', 'Parkside Properties', 'portland', { dom: 'parksideproperties.com', created: 40, terms: '1' }],
    ['nwpower', 'Northwest Power & Light', 'portland', { dom: 'nwpowerlight.com', created: 40, terms: '2' }],
    ['studiosupply', 'Studio Supply Co', 'portland', { dom: 'studiosupplyco.com', created: 38, terms: '3' }],
    ['hartley', 'Hartley Insurance Agency', 'portland', { dom: 'hartleyinsurance.com', created: 36, terms: '3' }],
    ['kline', 'Kline & Associates CPA', 'portland', { dom: 'klinecpa.com', created: 36, terms: '3' }],
  ]);
  const ctx = makeCtx(b, today);
  const { rng } = ctx;

  ctx.monthly('parkside', 14, 0, 1, () => ({ lines: [ctx.L('rent', ctx.usd(2400), 'Monthly rent - Studio suite 200')] }), 0);
  ctx.every('nwpower', 2, 14, 0, 12, () => ({ lines: [ctx.L('util', ctx.money(142, 0.15), 'Electric service')] }));
  ctx.scatter(10, 14, 0, () => ({
    vendor: 'studiosupply',
    lines: [
      ctx.L('supplies', ctx.money(210, 0.3), 'Drafting supplies'),
      ...(rng.chance(0.4) ? [ctx.L('office', ctx.money(64, 0.2), 'Printer paper and toner')] : []),
    ],
  }));
  ctx.every('hartley', 3, 14, 0, 6, () => ({ lines: [ctx.L('insurance', ctx.usd(612), "Business owner's policy premium")] }));
  ctx.every('kline', 3, 13, 0, 18, () => ({ lines: [ctx.L('legal', ctx.usd(480), 'Bookkeeping & tax advice')] }));

  const card = (m, dom, text, acct, amount, payee = null) =>
    b.expense({ date: ctx.at(m, dom), payee, from: 'card', lines: [ctx.L(acct, amount, text)] });
  [13, 11, 9, 6, 2].forEach((m) => card(m, 9, 'Adobe Creative Cloud subscription', 'dues', ctx.usd(54.99)));
  [12, 7, 3].forEach((m, i) => card(m, 16 + i, 'Client lunch', 'meals', ctx.money(58, 0.25)));
  [10, 4].forEach((m) => card(m, 21, 'Parking - client site visit', 'travel', ctx.money(18, 0.2)));
  [8, 1].forEach((m) => card(m, 12, 'Sample boards', 'supplies', ctx.money(96, 0.2), 'studiosupply'));

  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = plainAnswers({
    id, fixture, since, canWork: true,
    person: {
      name: 'Theo',
      role: 'Owner and principal designer; does the books himself on Sunday evenings',
      closingDate: null,
      knows: [
        'There are exactly five vendors: Parkside Properties (the landlord), Northwest Power & Light, Studio Supply Co, Hartley Insurance Agency and Kline & Associates CPA. No two of them are the same company.',
        'Each vendor is coded the same way every time: rent to Rent or Lease, electric to Utilities, drafting supplies to Supplies, printer paper to Office Expenses, the insurance policy to Insurance, the CPA to Legal & Professional Services.',
        'I have never closed the books or locked a period.',
        'We do not use classes, locations, items or any currency other than US dollars, and nothing on the books is billed on to a client.',
        'Nothing is wrong with these books.',
      ],
    },
  });
  return { fixture, answers };
}

export function buildEmpty(today) {
  const id = 'empty';
  const b = new Books({
    id: '9130358712660035', rng: new Rng(id), today,
    company: company({ name: 'Kestrel Studio LLC', plan: 'QuickBooks Online Simple Start', industry: 'Professional Services' }),
  });
  fullDefaultChart(b);
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = plainAnswers({
    id, fixture, since, canWork: true,
    person: {
      name: 'Priya',
      role: 'Founder; set the company up in QuickBooks this week and has not entered anything yet',
      closingDate: null,
      knows: [
        'The company file is brand new. There are no vendors, bills or expenses, and no bank account is connected yet.',
        'The chart of accounts is the default one QuickBooks created; I have not changed it.',
        'I have not closed any books.',
        'There is nothing to find yet, so the right answer to every question about the history is that there is none.',
      ],
    },
  });
  return { fixture, answers };
}

export function buildCardOnly(today) {
  const id = 'card-only';
  const b = new Books({
    id: '4620816371450218', rng: new Rng(id), today,
    company: company({ name: 'Oakhaven Mobile Detailing', plan: 'QuickBooks Online Simple Start', industry: 'Automotive Services' }),
  });
  compactChart(b, { card: 'Business Visa 7718' });
  // vendor key, name, how many charges, the one line text, account
  const spend = [
    ['pumpgo', 'Pump & Go Fuel', 26, 'Fuel', 'auto', 'tampa', 'pumpandgofuel.com', 46],
    ['detaildepot', 'Detail Depot Supply', 17, 'Detailing chemicals and microfiber', 'supplies', 'tampa', 'detaildepot.com', 140],
    ['shinepro', 'ShinePro Wholesale', 8, 'Wax, polish and pads', 'supplies', 'tampa', 'shineprowholesale.com', 120],
    ['aquapure', 'AquaPure Water Systems', 4, 'Water filter cartridges', 'supplies', 'tampa', 'aquapurewater.com', 85],
    ['dollardepot', "Penny's Variety Store", 6, 'Buckets, towels and sundries', 'supplies', 'tampa', null, 32],
    ['roadside', 'Roadside Auto Parts', 6, 'Van maintenance parts', 'repairs', 'tampa', 'roadsideautoparts.com', 74],
    ['northline', 'Northline Tire', 3, 'Tires and rotation', 'repairs', 'tampa', 'northlinetire.com', 420],
    ['fixit', 'Fix-It Tools & Hardware', 3, 'Tools and hardware', 'repairs', 'tampa', null, 66],
    ['quickprint', 'QuickPrint Cards & Flyers', 4, 'Flyers and door hangers', 'advert', 'tampa', 'quickprintcards.com', 88],
    ['sunrise', 'Sunrise Coffee', 8, 'Coffee and breakfast', 'meals', 'tampa', null, 11],
    ['cityparking', 'City Parking Authority', 8, 'Parking', 'travel', 'tampa', null, 9],
  ];
  const monthly = [
    ['loakoak', 'Lone Oak Insurance', 'Commercial auto insurance', 'insurance', 'loneoakinsurance.com', 189],
    ['cedarmobile', 'Cedar Mobile', 'Mobile phone service', 'util', 'cedarmobile.com', 64.5],
    ['bookit', 'BookIt Scheduler', 'Scheduling app subscription', 'dues', 'bookitscheduler.com', 39],
    ['spruce', 'Spruce Accounting Software', 'Accounting software subscription', 'dues', 'spruceaccounting.com', 30],
  ];
  addVendors(b, today, [
    ...spend.map(([key, name, , , , city, dom]) => [key, name, city, { dom, created: 30 }]),
    ...monthly.map(([key, name, , , dom]) => [key, name, 'tampa', { dom, created: 30 }]),
  ]);
  const ctx = makeCtx(b, today);
  const { rng } = ctx;

  for (const [key, , count, text, acct, , , median] of spend) {
    const slots = Array.from({ length: count }, () => ({ m: rng.int(0, 15), dom: rng.int(1, 28) }));
    for (const s of slots) {
      b.expense({ date: businessDay(dayOfMonthAgo(today, s.m, s.dom)), payee: key, from: 'card', lines: [ctx.L(acct, ctx.money(median, 0.3), text)] });
    }
  }
  for (const [key, , text, acct, , amount] of monthly) {
    const dom = rng.int(2, 26);
    for (let m = 15; m >= 0; m -= 1) {
      b.expense({ date: ctx.at(m, dom), payee: key, from: 'card', lines: [ctx.L(acct, ctx.usd(amount), text)] });
    }
  }

  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const lastYearEnd = `${Number(today.slice(0, 4)) - (today.slice(5, 7) <= '02' ? 2 : 1)}-12-31`;
  const answers = plainAnswers({
    id, fixture, since, canWork: true,
    person: {
      name: 'Lena',
      role: 'Owner-operator; runs the business from a van and pays for everything on the company Visa',
      closingDate: lastYearEnd,
      knows: [
        'I never enter bills. Everything is paid on the company Visa, so all the history is in expenses.',
        'There are 15 vendors and each one is coded the same way every time: fuel to Automobile, detailing supplies to Supplies, van parts and tires to Repairs & Maintenance, insurance to Insurance, phone to Utilities, the two software subscriptions to Dues & Subscriptions.',
        'No two vendors are the same company, and nothing has been refunded or miscoded.',
        `I close the books once a year with my accountant. The last close was through ${lastYearEnd}.`,
        'Nothing is wrong with these books.',
      ],
    },
  });
  return { fixture, answers };
}
