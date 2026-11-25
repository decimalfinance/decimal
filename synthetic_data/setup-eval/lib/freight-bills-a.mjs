// messy-freight, part A: the recurring, boring bills (rent, insurance, accountant,
// power, fuel, lawyer). These are most of the volume. A few of them carry planted
// truths, recorded in P for the answer key:
//   summit  - coding moved from Health Insurance to Employee Benefits on a date
//   harbor, whitaker, gridline, valleypet - one or two slips among many lines
//   crossroads, doyle - the same line text coded two ways for a reason only the person knows

import { diffDays } from './util.mjs';

/** The bill whose date is closest to `date`. */
export function nearest(bills, date) {
  return [...bills].sort((x, y) => Math.abs(diffDays(date, x.date)) - Math.abs(diffDays(date, y.date)))[0];
}

/** Hand out the items of a list in a shuffled, balanced order, over and over. */
function bag(rng, items) {
  let queue = [];
  return () => {
    if (!queue.length) queue = rng.shuffle(items);
    return queue.pop();
  };
}

const stepAt = (m, steps) => steps.find(([floor]) => m >= floor)[1];

export function recurringBills(ctx, P) {
  const { b, rng } = ctx;

  // ---- the landlord: three depots, three separate bills a month ----
  const depots = [
    { key: 'meridian1', n: 1, from: 29, to: 0, steps: [[18, 6400], [6, 6592], [0, 6790]], loc: 'memphis' },
    { key: 'meridian2', n: 2, from: 29, to: 0, steps: [[18, 5150], [6, 5305], [0, 5464]], loc: 'dallas' },
    { key: 'meridian3', n: 3, from: 15, to: 0, steps: [[0, 4380]], loc: 'columbus' },
  ];
  for (const d of depots) {
    ctx.monthly(d.key, d.from, d.to, 1, (m, date, i) => {
      const rent = ctx.usd(stepAt(m, d.steps));
      const text = rng.weighted([[`Monthly rent - Depot ${d.n}`, 7], [`Rent - Depot ${d.n}`, 2], [null, 1]]);
      const lines = [ctx.L('termrent', rent, text)];
      if (i % 3 === 0) lines.push(ctx.L('termrent', ctx.money(410, 0.08), `CAM / property tax reimbursement - Depot ${d.n}`));
      const stepped = d.steps.some(([floor]) => floor > 0 && m === floor - 1);
      return {
        lines,
        note: stepped ? 'Annual 3% increase per lease' : null,
        location: m <= 9 && rng.chance(0.5) ? d.loc : null,
      };
    }, 0);
  }

  // ---- insurance: monthly installments; one cargo line slipped into Auto Liability ----
  const harbor = ctx.monthly('harbor', 29, 0, 5, (m) => ({
    lines: [
      ctx.L('insauto', ctx.usd(stepAt(m, [[18, 3720], [6, 3962.5], [0, 4180]])), 'Auto liability premium installment'),
      ctx.L('inscargo', ctx.usd(stepAt(m, [[18, 1310], [6, 1402], [0, 1455]])), 'Cargo coverage premium installment'),
    ],
  }));
  const harborSlip = nearest(harbor, ctx.at(8, 5));
  harborSlip.lines[1].acct = b.acct('insauto');
  P.slips.harbor = [harborSlip];

  // ---- health premium: coded to Health Insurance until the chart was reorganised, then to Employee Benefits ----
  P.summitChangedOn = ctx.at(11, 12);
  ctx.monthly('summit', 29, 0, 12, (m, date) => ({
    lines: [
      ctx.L(date >= P.summitChangedOn ? 'benefits' : 'inshealth', ctx.usd(stepAt(m, [[18, 6420], [6, 6880], [0, 7310]])), 'Group health premium'),
    ],
  }), 0);

  // ---- workers comp, quarterly ----
  ctx.every('pioneer', 3, 28, 1, 20, (m, date, i) => {
    const lines = [ctx.L('inswc', ctx.money(4120, 0.05), 'Workers comp premium installment')];
    if (i === 4 || i === 8) lines.push(ctx.L('inswc', ctx.money(1860, 0.2), 'Premium audit adjustment'));
    return { lines };
  });

  // ---- the accountant: a monthly retainer, a tax return each spring, one retainer slipped into Software ----
  const whitaker = ctx.monthly('whitaker', 29, 0, 28, (m, date) => {
    const lines = [ctx.L('accounting', ctx.usd(m >= 14 ? 2250 : 2400), 'Monthly bookkeeping & advisory retainer')];
    if (date.slice(5, 7) === '03') lines.push(ctx.L('accounting', ctx.money(4800, 0.05), `${Number(date.slice(0, 4)) - 1} federal & state tax return preparation`));
    if (m <= 6 && m >= 5) lines.push(ctx.L('accounting', ctx.money(320, 0.2), 'Sales tax filing assistance', { cls: 'admin' }));
    return { lines };
  });
  const whitakerSlip = nearest(whitaker, ctx.at(10, 28));
  whitakerSlip.lines[0].acct = b.acct('software');
  P.slips.whitaker = [whitakerSlip];

  // ---- the power company: one line per depot, two lines slipped into Telephone ----
  const season = (date) => ({ '06': 1.3, '07': 1.4, '08': 1.38, '09': 1.15, '05': 1.12, '12': 1.08, '01': 1.1, '02': 1.08 })[date.slice(5, 7)] ?? 1;
  const gridline = ctx.monthly('gridline', 29, 0, 22, (m, date) => {
    const lines = [
      ctx.L('electric', ctx.money(1850 * season(date), 0.05), rng.chance(0.8) ? 'Electric - Depot 1' : null),
      ctx.L('electric', ctx.money(1420 * season(date), 0.05), rng.chance(0.8) ? 'Electric - Depot 2' : null),
    ];
    if (m <= 15) lines.push(ctx.L('electric', ctx.money(1180 * season(date), 0.05), rng.chance(0.8) ? 'Electric - Depot 3' : null));
    return { lines };
  });
  const slipA = nearest(gridline, ctx.at(13, 22));
  const slipB = nearest(gridline, ctx.at(5, 22));
  for (const slip of [slipA, slipB]) {
    slip.lines[1].desc = 'Electric - Depot 2';
    slip.lines[1].acct = b.acct('phone');
  }
  P.slips.gridline = [slipA, slipB];

  // ---- the lawyer: "Legal services" goes to Legal Fees or to Cargo Claims, and only the person knows which ----
  const legalAcct = bag(rng, ['legalfees', 'legalfees', 'legalfees', 'legalfees', 'claims', 'claims', 'claims', 'claims']);
  const doyle = ctx.scatter(13, 28, 1, () => {
    const lines = [ctx.L(legalAcct(), ctx.money(2400, 0.6), 'Legal services')];
    if (rng.chance(0.3)) lines.push(ctx.L('legalfees', ctx.money(185, 0.3), 'Court filing fees'));
    return { vendor: 'doyle', lines };
  });
  P.doyle = doyle;

  // ---- fuel card: two statements a month, "Fuel - diesel" on both, coded to Fuel or to Driver Fuel Advances ----
  const crossroads = [];
  for (let m = 29; m >= 0; m -= 1) {
    const both = rng.chance(0.4);
    const companyFirst = rng.chance(0.5);
    const rebate = rng.chance(0.2);
    const company = [ctx.L('fuel', ctx.money(16500, 0.18), 'Fuel - diesel')];
    if (rebate) company.push(ctx.L('fuel', -ctx.money(380, 0.2), 'Volume rebate'));
    const lease = [ctx.L('drvadv', ctx.money(3300, 0.35), 'Fuel - diesel')];
    const order = companyFirst ? [company, both ? lease : null] : [both ? lease : null, company];
    order.filter(Boolean).forEach((lines, k) => {
      crossroads.push(ctx.bill('crossroads', ctx.at(m, 3 + k), lines, {}));
    });
  }
  P.crossroads = crossroads;

  // ---- bulk diesel for the yard tank; one delivery slipped into Tractor repairs ----
  const valley = ctx.scatter(25, 29, 0, () => ({
    vendor: 'valleypet',
    lines: [ctx.L('fuel', ctx.money(9200, 0.22), 'Bulk diesel delivery - yard tank')],
  }));
  const valleySlip = nearest(valley.filter((x) => ctx.inWindow(x.date)), ctx.at(11, 15));
  valleySlip.lines[0].acct = b.acct('rtractors');
  P.slips.valleypet = [valleySlip];
}
