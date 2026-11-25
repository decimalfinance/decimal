#!/usr/bin/env node
// Builds the setup exam: synthetic QuickBooks companies with messy books, and the
// hidden answers for each.
//
//   node generate.mjs [YYYY-MM-DD]      today's date by default
//
// Every date in the books is relative to that date, so the files can be rebuilt
// when they age. Same date in, same bytes out. Writes companies/<id>.json (a
// BooksFixture: company, accounts, vendors, bills, expenses; every *Minor field a
// decimal string) and answers/<id>.json, then checks both.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMonths, isDate } from './lib/util.mjs';
import { buildFreight } from './lib/freight.mjs';
import { buildCardOnly, buildEmpty, buildSmallClean } from './lib/small-a.mjs';
import { buildClosedBooks, buildLapsed, buildPounds } from './lib/small-b.mjs';
import { checkAll } from './lib/check.mjs';
import { writeXero } from './xero.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const today = process.argv[2] ?? localToday();
if (!isDate(today)) {
  console.error(`Not a date: ${today}. Use YYYY-MM-DD.`);
  process.exit(2);
}

const builders = [
  ['messy-freight', buildFreight],
  ['small-clean', buildSmallClean],
  ['empty', buildEmpty],
  ['card-only', buildCardOnly],
  ['pounds', buildPounds],
  ['lapsed', buildLapsed],
  ['closed-books', buildClosedBooks],
];

mkdirSync(join(HERE, 'companies'), { recursive: true });
mkdirSync(join(HERE, 'answers'), { recursive: true });

for (const [id, build] of builders) {
  const { fixture, answers } = build(today);
  writeFileSync(join(HERE, 'companies', `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  writeFileSync(join(HERE, 'answers', `${id}.json`), `${JSON.stringify(answers, null, 2)}\n`);
  console.log(`${id}: ${fixture.vendors.length} vendors, ${fixture.accounts.length} accounts, ${fixture.bills.length} bills, ${fixture.expenses.length} expenses`);
}

// Read everything back from disk and fail if the exam contradicts itself.
const problems = checkAll({ dir: HERE, today, ids: builders.map(([id]) => id) });
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
  if (problems.length > 60) console.error(`  ... and ${problems.length - 60} more`);
  process.exit(1);
}
console.log(`ok: ${builders.length} companies written and checked (today ${today}, window opens ${addMonths(today, -24)})`);

// The same companies as Xero organisations, for the eval's Xero runs, and the bench's Xero demo.
writeXero();
