// messy-freight, part B: carriers and owner-operators (purchased transportation).
// Planted here:
//   ridgeline, bluegrass - one real vendor entered twice, history split between the records
//   two bills entered twice (ridgeline across both records, apex on one record)
//   apex vs apex logistics, rjhaul vs mmtrans - different businesses that look alike
//   a Canadian-dollar bill, a peso bill, detention billed on to a customer, an old unpaid bill

import { addDays } from './util.mjs';

function loads(ctx, count, median, sigma, acct, opts = {}) {
  const { rng } = ctx;
  return Array.from({ length: count }, () => {
    const o = {};
    if (opts.cls && rng.chance(opts.cls[1])) o.cls = opts.cls[0];
    return ctx.L(acct, ctx.money(median, sigma), opts.text ? opts.text() : ctx.load(opts.label), o);
  });
}

export function carrierBills(ctx, P) {
  const { b, rng } = ctx;
  const n = () => rng.weighted([[1, 6], [2, 3], [3, 1]]);

  // ---- Ridgeline: two records for one carrier; the second appears 19 months ago and both are used from then on ----
  const ridgeline = ctx.scatter(26, 29, 0, (m) => ({
    vendor: 'ridgeline1',
    lines: loads(ctx, n(), 2350, 0.4, 'ptline', { cls: m <= 10 ? ['linehaul', 0.5] : null }),
  }));
  ctx.moveSome(ridgeline, 'ridgeline2', 9, (age) => age < 19);
  P.ridgeline = ridgeline;

  // The same invoice, keyed once against each record.
  const rcDate = ctx.at(7, 9);
  const rcLine = () => [ctx.L('ptline', ctx.usd(3420), 'Load 52107 - Atlanta GA to Columbus OH')];
  P.dupRidgeline = [
    ctx.bill('ridgeline1', rcDate, rcLine(), { number: 'RC-20817', status: 'paid' }),
    ctx.bill('ridgeline2', addDays(rcDate, 3), rcLine(), { number: 'RC-20817', status: 'open' }),
  ];

  // ---- Apex Freight (a trucking company in Ohio) ----
  const apex1 = ctx.scatter(12, 29, 0, () => ({
    vendor: 'apex1',
    lines: loads(ctx, rng.chance(0.3) ? 2 : 1, 2900, 0.35, 'ptline', { text: () => `Load ${rng.int(41000, 58999)} - Columbus OH to ${rng.pick(['Chicago IL', 'Indianapolis IN', 'Cincinnati OH', 'Pittsburgh PA'])}` }),
  }));
  const apexRecent = apex1.filter((x) => ctx.inWindow(x.date));
  for (const bill of [apexRecent[1], apexRecent[Math.min(5, apexRecent.length - 1)]]) {
    bill.lines.push(ctx.L('ptline', ctx.money(225, 0.1), 'Detention - 3 hrs at shipper dock', { customer: 'great' }));
    bill.total += bill.lines[bill.lines.length - 1].amount;
    if (bill.balance > 0n) bill.balance = bill.total;
  }
  P.billableApex = [apexRecent[1], apexRecent[Math.min(5, apexRecent.length - 1)]];

  // The same invoice number and amount, entered nine days apart.
  const afDate = ctx.at(6, 10);
  const afLine = () => [ctx.L('ptline', ctx.usd(2950), 'Load 49377 - Columbus OH to Indianapolis IN')];
  P.dupApex = [
    ctx.bill('apex1', afDate, afLine(), { number: 'AF-7741', status: 'paid' }),
    ctx.bill('apex1', addDays(afDate, 9), afLine(), { number: 'AF-7741', status: 'open' }),
  ];

  // ---- Apex Freight Logistics (a broker in Texas, net 60, charges sales tax) ----
  const apex2 = ctx.scatter(6, 22, 0, (m) => {
    const lines = [
      ctx.L('ptline', ctx.money(3100, 0.3), `Brokered load ${rng.int(81000, 89999)} - Houston TX to Dallas TX`, m <= 12 ? { tax: 'TAX', cls: 'brokerage' } : { tax: 'TAX' }),
      ctx.L('ptline', ctx.money(310, 0.2), 'Fuel surcharge', { tax: 'TAX' }),
    ];
    const base = lines.reduce((s, l) => s + l.amount, 0n);
    return { vendor: 'apex2', lines, tax: (base * 825n + 5000n) / 10000n };
  });
  P.apex2 = apex2;
  const apexDisputed = apex2.find((x) => x.date <= ctx.at(4, 1)) ?? apex2[0];
  apexDisputed.balance = apexDisputed.total; // disputed, never paid

  // ---- Bluegrass Haulers: "Blue Grass" appears 12 months ago ----
  P.bluegrass = ctx.scatter(16, 29, 0, () => ({
    vendor: 'bluegrass1',
    lines: loads(ctx, n(), 1900, 0.35, 'ptline'),
  }));
  ctx.moveSome(P.bluegrass, 'bluegrass2', 6, (age) => age < 12);

  // ---- ordinary carriers, one record each ----
  const plain = (key, count, from, median, label) => ctx.scatter(count, from, 0, () => ({
    vendor: key,
    lines: loads(ctx, n(), median, 0.35, 'ptline', { label }),
  }));
  const bigsky = plain('bigsky', 10, 29, 3300, 'Load');
  plain('mesa', 8, 27, 3850, 'Load');
  plain('prairie', 7, 27, 1750, 'Load');
  plain('lonestar', 8, 29, 3600, 'Reefer load');
  plain('keystone', 6, 24, 2700, 'Flatbed load');
  // A statement with a text-only line under the loads.
  for (const bill of bigsky.filter((x) => ctx.inWindow(x.date)).slice(1, 4)) {
    bill.lines.push(b.line({ other: true, amount: 0n, desc: 'Load detail on attached statement', tax: null }));
  }

  // ---- drayage; two loads on one day at the same price are two bills, not one ----
  ctx.scatter(12, 29, 0, (m) => ({
    vendor: 'cardinal',
    lines: [ctx.L('ptdray', ctx.money(1425, 0.25), `Drayage ${rng.pick(['port to yard', 'yard to port', 'port to rail ramp'])} - container ${rng.pick(['MSKU', 'TGHU', 'CMAU', 'HLXU'])}${rng.int(1000000, 9999999)}`, m <= 16 && rng.chance(0.6) ? { cls: 'drayage' } : {})],
  }));
  const sameDay = ctx.at(10, 17);
  P.notDuplicates = [
    ctx.bill('cardinal', sameDay, [ctx.L('ptdray', ctx.usd(1425), 'Drayage port to yard - container MSKU5128830')], {}),
    ctx.bill('cardinal', sameDay, [ctx.L('ptdray', ctx.usd(1425), 'Drayage port to yard - container TGHU7740921')], {}),
  ];

  // ---- two small owner-operators whose bills both go to one bookkeeper's inbox ----
  const settle = (key, count, from) => ctx.scatter(count, from, 0, (m, date) => {
    const lines = [ctx.L('ptoo', ctx.money(1650, 0.3), `Settlement - ${ctx.weekEnding(date)}`)];
    if (rng.chance(0.4)) lines.push(ctx.L('ptoo', -ctx.money(180, 0.3), 'Fuel advance deduction'));
    return { vendor: key, lines };
  });
  settle('rjhaul', 8, 25);
  const mm = settle('mmtrans', 7, 22);
  const forgotten = mm.find((x) => x.date <= ctx.at(12, 28) && ctx.inWindow(x.date)) ?? mm[0];
  forgotten.balance = forgotten.total; // never paid

  // ---- foreign currency: one Canadian carrier (one of its two bills is older than the window), one Mexican ----
  const cad = (m, dom) => ctx.bill('northern', ctx.at(m, dom), [ctx.L('ptline', ctx.money(4900, 0.2), `Load ${rng.int(71000, 79999)} - Calgary AB to Memphis TN (cross-border)`)], { currency: 'CAD', ap: 'apcad' });
  cad(26, 11);
  P.cad = [cad(3, 20)];
  P.mxn = [ctx.bill('norte', ctx.at(6, 14), [ctx.L('ptline', ctx.usd(38500), 'Flete Monterrey NL - Laredo TX (cruce fronterizo)')], { currency: 'MXN', ap: 'apmxn' })];

  // ---- two carriers that stopped being used ----
  ctx.scatter(6, 29, 21, () => ({ vendor: 'silverline', lines: [ctx.L('subcontract', ctx.money(1800, 0.4), ctx.load('Expedited load'))] }));
  ctx.scatter(5, 29, 25, () => ({ vendor: 'tristate', lines: [ctx.L('ptline', ctx.money(2100, 0.3), ctx.load('Dedicated run'))] }));
}
