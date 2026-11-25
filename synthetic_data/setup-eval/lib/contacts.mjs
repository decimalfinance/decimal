// Phone numbers, street addresses and mailboxes for synthetic vendors. Numbers use
// the 555-01xx block, which is reserved for fiction.

import { dayOfMonthAgo } from './util.mjs';

// key: [city, state, zip codes, area code]
export const CITIES = {
  memphis: ['Memphis', 'TN', ['38103', '38116', '38118', '38141'], '901'],
  dallas: ['Dallas', 'TX', ['75207', '75212', '75247'], '214'],
  columbus: ['Columbus', 'OH', ['43207', '43228', '43219'], '614'],
  atlanta: ['Atlanta', 'GA', ['30336', '30318', '30340'], '404'],
  louisville: ['Louisville', 'KY', ['40213', '40209', '40258'], '502'],
  indianapolis: ['Indianapolis', 'IN', ['46241', '46222', '46218'], '317'],
  kansascity: ['Kansas City', 'MO', ['64120', '64161', '64129'], '816'],
  nashville: ['Nashville', 'TN', ['37210', '37211', '37228'], '615'],
  chicago: ['Chicago', 'IL', ['60632', '60609', '60638'], '312'],
  stlouis: ['St. Louis', 'MO', ['63118', '63120', '63111'], '314'],
  cincinnati: ['Cincinnati', 'OH', ['45214', '45237', '45246'], '513'],
  okc: ['Oklahoma City', 'OK', ['73108', '73129', '73127'], '405'],
  littlerock: ['Little Rock', 'AR', ['72206', '72209', '72204'], '501'],
  birmingham: ['Birmingham', 'AL', ['35217', '35210', '35224'], '205'],
  jackson: ['Jackson', 'MS', ['39209', '39212', '39204'], '601'],
  houston: ['Houston', 'TX', ['77029', '77032', '77041'], '713'],
  billings: ['Billings', 'MT', ['59101', '59102'], '406'],
  phoenix: ['Phoenix', 'AZ', ['85043', '85009', '85034'], '602'],
  savannah: ['Savannah', 'GA', ['31408', '31405'], '912'],
  pittsburgh: ['Pittsburgh', 'PA', ['15238', '15212', '15205'], '412'],
  portland: ['Portland', 'OR', ['97209', '97214', '97232'], '503'],
  denver: ['Denver', 'CO', ['80216', '80202', '80211'], '303'],
  raleigh: ['Raleigh', 'NC', ['27601', '27604', '27609'], '919'],
  boise: ['Boise', 'ID', ['83702', '83705', '83709'], '208'],
  minneapolis: ['Minneapolis', 'MN', ['55401', '55413', '55414'], '612'],
  tampa: ['Tampa', 'FL', ['33602', '33609', '33607'], '813'],
};

const STREETS = [
  'Distribution Pkwy', 'Commerce Dr', 'Industrial Blvd', 'Airways Blvd', 'Mill Rd', 'Harbor Ave', 'Main St', 'Railroad Ave',
  'Jefferson Hwy', 'Park Ave', 'Frontage Rd', 'Lakeshore Dr', 'Freight Ln', 'Depot St', 'Oak Ridge Rd', 'Cedar Ln',
  'Brooks Rd', 'Rickenbacker Way', 'Fulton Industrial Blvd', 'Gulf Fwy', 'Elm St', 'Washington Ave', 'Truck Plaza Rd',
];

const MAILBOXES = [['ar', 5], ['billing', 5], ['accounting', 3], ['invoices', 2], ['accounts', 2], ['office', 2], ['sales', 1]];

/**
 * One vendor's contact block. `o` may pin any piece (email, phone, street, suite, zip,
 * mail, dom, address) or switch one off (noEmail, noPhone, noAddress).
 */
export function makeContact(rng, used, city, o = {}) {
  const [name, st, zips, area] = CITIES[city] ?? CITIES.memphis;
  let phone = o.phone ?? null;
  if (!phone && !o.noPhone) {
    do {
      phone = `(${area}) 555-01${String(rng.int(0, 99)).padStart(2, '0')}`;
    } while (used.has(phone));
  }
  if (phone) used.add(phone);

  const street = o.street ?? `${rng.int(100, 9800)} ${rng.pick(STREETS)}`;
  const zip = o.zip ?? rng.pick(zips);
  const address = o.noAddress ? null : o.address ?? `${[street, o.suite].filter(Boolean).join(', ')}, ${name}, ${st}, ${zip}`;

  let email = o.email ?? null;
  if (!email && o.dom && !o.noEmail) email = `${o.mail ?? rng.weighted(MAILBOXES)}@${o.dom}`;
  return { phone: o.noPhone ? null : phone, address, email: o.noEmail ? null : email };
}

/** A date `monthsAgo` months back, on a day of the month the generator picks. */
export function createdOn(rng, today, monthsAgo) {
  return dayOfMonthAgo(today, monthsAgo, rng.int(1, 28));
}
