// messy-freight: the main exam. A US trucking and brokerage company on QuickBooks
// Online, 30 months of books, most of it ordinary and repetitive.

import { Books } from './books.mjs';
import { makeCtx } from './ctx.mjs';
import { Rng, addMonths } from './util.mjs';
import { buildChart } from './freight-chart.mjs';
import { buildVendors } from './freight-vendors.mjs';
import { recurringBills } from './freight-bills-a.mjs';
import { carrierBills } from './freight-bills-b.mjs';
import { repairBills } from './freight-bills-c.mjs';
import { expenseRecords } from './freight-expenses.mjs';
import { freightAnswers } from './freight-answers.mjs';

// Vendors whose line text is left alone: the planted coding truths and the injected text live there.
const PLAIN_TEXT = new Set(['harbor', 'summit', 'whitaker', 'gridline', 'valleypet', 'crossroads', 'doyle', 'hollis', 'fleetline', 'workwear', 'dockside', 'pioneer', 'prairietrailers']);

/** Real bookkeeping leaves lines blank or says "services": do that to some lines of ordinary vendors. */
function sprinkleVagueText(ctx, keep) {
  const skip = new Set(Object.values(keep).flat());
  for (const bill of ctx.b.bills) {
    if (skip.has(bill) || PLAIN_TEXT.has(bill.vendor.key)) continue;
    for (const line of bill.lines) {
      if (line.kind !== 'account' || line.desc === null) continue;
      line.desc = ctx.vague(line.desc, 0.12);
    }
  }
}

export function buildFreight(today) {
  const rng = new Rng('messy-freight');
  const b = new Books({
    id: '9341455812650027',
    rng,
    today,
    company: {
      name: 'Ironbridge Freight Services, LLC',
      country: 'US',
      homeCurrency: 'USD',
      plan: 'QuickBooks Online Plus',
      subscriptionStatus: 'ACTIVE',
      fiscalYearStartMonth: 'January',
      industry: 'Freight and Trucking',
      closingDate: null,
      multiCurrency: true,
      salesTax: true,
      accountNumbers: true,
      classes: 'per_line',
      locations: true,
      locationLabel: 'Terminal',
    },
  });
  buildChart(b);
  buildVendors(b, today);

  const ctx = makeCtx(b, today);
  const P = { slips: {} };
  recurringBills(ctx, P);
  carrierBills(ctx, P);
  repairBills(ctx, P);
  sprinkleVagueText(ctx, { dupRidgeline: P.dupRidgeline, dupApex: P.dupApex, dupHollis: P.dupHollis, notDup: P.notDuplicates });
  expenseRecords(ctx, P);

  b.prune();
  const fixture = b.finish();
  const since = addMonths(today, -24);
  const answers = freightAnswers({ b, P, fixture, today, since });
  return { fixture, answers };
}
