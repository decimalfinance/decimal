// Checks that the hidden answers are true of the books they describe, and that
// every id they cite exists. An answer the data does not bear out is a broken
// exam, so each claim is tested against the records, not just looked up.

const ANSWER_KEYS = ['companyId', 'canWork', 'blockingReason', 'person', 'sameVendors', 'differentVendors', 'codedTwoWays', 'codingChanged', 'slips', 'cantPost', 'injections', 'duplicateBills', 'facts'];
const FACT_KEYS = ['since', 'bills', 'billsUnpaid', 'expenses', 'vendors', 'activeVendors', 'accounts', 'activeAccounts', 'billsTotalUsd', 'expensesTotalUsd', 'unpaidUsd'];
const ENTRY_KEYS = {
  sameVendors: ['id', 'vendorIds', 'useVendorId', 'why'],
  differentVendors: ['id', 'vendorIds', 'hardToTell', 'why'],
  codedTwoWays: ['id', 'vendorId', 'line', 'categoryIds', 'rightCategoryId', 'why'],
  codingChanged: ['id', 'vendorId', 'line', 'oldCategoryId', 'newCategoryId', 'changedOn', 'why'],
  slips: ['id', 'vendorId', 'billIds', 'why'],
  injections: ['id', 'ref', 'text'],
  duplicateBills: ['id', 'billIds', 'why'],
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sameKeys(obj, keys, where, fail) {
  for (const k of keys) if (!(k in obj)) fail(`${where}: missing ${k}`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`${where}: unexpected ${k}`);
}

const mode = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, z) => z[1] - a[1])[0] ?? [null, 0];
};

export function checkAnswers(co, answers, today, since, fail) {
  sameKeys(answers, ANSWER_KEYS, 'answers', fail);
  sameKeys(answers.facts ?? {}, FACT_KEYS, 'answers.facts', fail);
  sameKeys(answers.person ?? {}, ['name', 'role', 'closingDate', 'knows'], 'answers.person', fail);
  for (const [list, keys] of Object.entries(ENTRY_KEYS)) {
    if (!Array.isArray(answers[list])) fail(`answers.${list} is not a list`);
    else {
      const seen = new Set();
      answers[list].forEach((x, i) => {
        sameKeys(x, keys, `answers.${list}[${i}]`, fail);
        if (seen.has(x.id)) fail(`answers.${list}: id ${x.id} used twice`);
        seen.add(x.id);
      });
    }
  }

  const vendorById = new Map(co.vendors.map((v) => [v.id, v]));
  const accountById = new Map(co.accounts.map((a) => [a.id, a]));
  const billById = new Map(co.bills.map((b) => [b.id, b]));
  const expenseById = new Map(co.expenses.map((e) => [e.id, e]));
  const vendor = (id, where) => {
    if (!vendorById.has(id)) fail(`${where}: vendor ${id} does not exist`);
    return vendorById.get(id);
  };
  const account = (id, where) => {
    if (!accountById.has(id)) fail(`${where}: account ${id} does not exist`);
    return accountById.get(id);
  };
  const bill = (id, where) => {
    const b = billById.get(id);
    if (!b) fail(`${where}: bill ${id} does not exist`);
    else if (!(b.date >= since)) fail(`${where}: bill ${id} is dated ${b.date}, before the window opens on ${since}`);
    return b;
  };
  const windowLines = (vendorId) =>
    co.bills.filter((b) => b.vendorId === vendorId && b.date >= since).flatMap((b) => b.lines.map((l, index) => ({ bill: b, line: l, index })));

  // ---- the person and the verdict ----
  const p = answers.person ?? {};
  if (!p.name || !p.role) fail('person needs a name and a role');
  if (!(p.closingDate === null || (DATE.test(p.closingDate) && p.closingDate <= today))) fail(`person.closingDate ${p.closingDate} is not a past date or null`);
  if (co.company.closingDate !== null && p.closingDate !== co.company.closingDate) fail('the person must agree with company.closingDate');
  if (!Array.isArray(p.knows) || p.knows.some((x) => typeof x !== 'string' || !x.trim())) fail('person.knows must be a list of text lines');
  if (answers.canWork === true && answers.blockingReason !== null) fail('canWork is true but there is a blockingReason');
  if (answers.canWork === false && !(typeof answers.blockingReason === 'string' && answers.blockingReason.trim())) fail('canWork is false but there is no blockingReason');
  const couldWork = co.company.homeCurrency === 'USD' && co.company.subscriptionStatus === 'ACTIVE';
  if (answers.canWork !== couldWork) fail(`canWork is ${answers.canWork} but the company is ${co.company.homeCurrency}/${co.company.subscriptionStatus}`);
  for (const c of answers.cantPost ?? []) if (!['item_lines', 'classes', 'locations', 'other_currency', 'billable_to_customer'].includes(c)) fail(`cantPost: unknown ${c}`);

  // ---- same vendor, more than one record ----
  const sameGroups = new Map();
  for (const g of answers.sameVendors ?? []) {
    const where = `sameVendors ${g.id}`;
    const members = g.vendorIds.map((id) => vendor(id, where)).filter(Boolean);
    if (g.vendorIds.length < 2) fail(`${where}: needs two or more records`);
    if (!g.vendorIds.includes(g.useVendorId)) fail(`${where}: useVendorId is not one of the records`);
    const use = vendorById.get(g.useVendorId);
    if (use) {
      for (const m of members) {
        if (m === use) continue;
        const shared = (m.phone && m.phone === use.phone) || (m.email && m.email === use.email) || (m.address && m.address === use.address);
        if (!shared) fail(`${where}: ${m.name} shares no phone, email or address with ${use.name}`);
      }
    }
    const used = g.vendorIds.filter((id) => co.bills.some((b) => b.vendorId === id && b.date >= since));
    if (used.length < 2) fail(`${where}: history is not split between records in the window`);
    for (const id of g.vendorIds) sameGroups.set(id, g.id);
  }

  // ---- different vendors that look alike ----
  for (const g of answers.differentVendors ?? []) {
    const where = `differentVendors ${g.id}`;
    const members = g.vendorIds.map((id) => vendor(id, where)).filter(Boolean);
    if (g.vendorIds.length < 2) fail(`${where}: needs two or more records`);
    if (typeof g.hardToTell !== 'boolean') fail(`${where}: hardToTell must be true or false`);
    for (const x of g.vendorIds) for (const y of g.vendorIds) if (x < y && sameGroups.has(x) && sameGroups.get(x) === sameGroups.get(y)) fail(`${where}: ${x} and ${y} are also listed as the same vendor`);
    if (g.hardToTell && members.length > 1 && !(members.every((m) => m.phone === members[0].phone) && members.every((m) => m.address === members[0].address))) {
      fail(`${where}: marked hard to tell but the records differ in phone or address`);
    }
  }

  // ---- one line text, two categories, a reason only the person knows ----
  for (const g of answers.codedTwoWays ?? []) {
    const where = `codedTwoWays ${g.id}`;
    vendor(g.vendorId, where);
    const cats = g.categoryIds.map((id) => account(id, where));
    if (cats.length !== 2) fail(`${where}: exactly two categories expected`);
    if (g.rightCategoryId !== null && !g.categoryIds.includes(g.rightCategoryId)) fail(`${where}: rightCategoryId is not one of the categories`);
    const same = windowLines(g.vendorId).filter((x) => x.line.description === g.line && x.line.kind === 'account');
    const counts = new Map();
    for (const x of same) counts.set(x.line.accountId, (counts.get(x.line.accountId) ?? 0) + 1);
    for (const id of g.categoryIds) if ((counts.get(id) ?? 0) < 3) fail(`${where}: only ${counts.get(id) ?? 0} lines in the window use category ${id}`);
    for (const id of counts.keys()) if (!g.categoryIds.includes(id)) fail(`${where}: the text is also coded to ${id}`);
    const ids = g.categoryIds;
    const a = same.filter((x) => x.line.accountId === ids[0]);
    const z = same.filter((x) => x.line.accountId === ids[1]);
    const lastA = a.map((x) => x.bill.date).sort().at(-1);
    const firstZ = z.map((x) => x.bill.date).sort()[0];
    const lastZ = z.map((x) => x.bill.date).sort().at(-1);
    const firstA = a.map((x) => x.bill.date).sort()[0];
    if (a.length && z.length && (lastA < firstZ || lastZ < firstA)) fail(`${where}: the two categories are separated in time, which would make it a change, not a split`);
  }

  // ---- coding changed on a date ----
  for (const g of answers.codingChanged ?? []) {
    const where = `codingChanged ${g.id}`;
    vendor(g.vendorId, where);
    account(g.oldCategoryId, where);
    account(g.newCategoryId, where);
    if (!DATE.test(g.changedOn)) fail(`${where}: changedOn ${g.changedOn} is not a date`);
    const same = windowLines(g.vendorId).filter((x) => x.line.description === g.line && x.line.kind === 'account');
    const before = same.filter((x) => x.bill.date < g.changedOn);
    const after = same.filter((x) => x.bill.date >= g.changedOn);
    if (before.length < 4 || after.length < 4) fail(`${where}: need at least 4 lines each side of the date in the window (have ${before.length} and ${after.length})`);
    for (const x of before) if (x.line.accountId !== g.oldCategoryId) fail(`${where}: bill ${x.bill.id} (${x.bill.date}) should use the old category`);
    for (const x of after) if (x.line.accountId !== g.newCategoryId) fail(`${where}: bill ${x.bill.id} (${x.bill.date}) should use the new category`);
    if (!after.some((x) => x.bill.date === g.changedOn)) fail(`${where}: no line is dated on changedOn itself`);
  }

  // ---- slips: a miscoded line among many ----
  for (const g of answers.slips ?? []) {
    const where = `slips ${g.id}`;
    vendor(g.vendorId, where);
    if (g.billIds.length < 1 || g.billIds.length > 2) fail(`${where}: one or two stray lines expected`);
    const cited = new Set(g.billIds);
    for (const id of g.billIds) bill(id, where);
    const lines = windowLines(g.vendorId).filter((x) => x.line.kind === 'account');
    const deviant = [];
    for (const x of lines) {
      if (x.line.description === null) continue;
      const peers = lines.filter((y) => y.line.description === x.line.description);
      const [top, topCount] = mode(peers.map((y) => y.line.accountId));
      if (peers.length >= 8 && topCount / peers.length >= 0.85 && x.line.accountId !== top) deviant.push(x);
    }
    const deviantBills = new Set(deviant.map((x) => x.bill.id));
    for (const id of cited) if (!deviantBills.has(id)) fail(`${where}: bill ${id} has no line that stands apart from its vendor's usual coding`);
    for (const id of deviantBills) if (!cited.has(id)) fail(`${where}: bill ${id} also has a stray line that the answer does not list`);
  }

  // ---- nothing look-alike outside the answer key ----
  // Two vendors sharing a phone, email or address must both be in one listed group, same or different.
  const listed = [...(answers.sameVendors ?? []), ...(answers.differentVendors ?? [])];
  const together = (x, y) => listed.some((g) => g.vendorIds.includes(x) && g.vendorIds.includes(y));
  for (const field of ['phone', 'email', 'address']) {
    const byValue = new Map();
    for (const v of co.vendors) if (v[field]) byValue.set(v[field], [...(byValue.get(v[field]) ?? []), v.id]);
    for (const [value, ids] of byValue) {
      for (const x of ids) for (const y of ids) if (x < y && !together(x, y)) fail(`vendors ${x} and ${y} share a ${field} (${value}) but are in no listed group`);
    }
  }
  const norm = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|co|corp|company|the)\b/g, '').replace(/\s+/g, ' ').trim();
  const byName = new Map();
  for (const v of co.vendors) byName.set(norm(v.name), [...(byName.get(norm(v.name)) ?? []), v.id]);
  for (const ids of byName.values()) for (const x of ids) for (const y of ids) if (x < y && !together(x, y)) fail(`vendors ${x} and ${y} have the same name apart from case, punctuation and legal form, and are in no listed group`);

  // ---- the person can speak to everything in the key ----
  const said = (p.knows ?? []).join('\n').toLowerCase();
  const mention = (text, where) => {
    if (!said.includes(String(text).toLowerCase())) fail(`${where}: nothing in person.knows mentions "${text}"`);
  };
  for (const g of [...(answers.sameVendors ?? []), ...(answers.differentVendors ?? [])]) for (const id of g.vendorIds) if (vendorById.get(id)) mention(vendorById.get(id).name, `knows for ${g.id}`);
  for (const g of [...(answers.codedTwoWays ?? []), ...(answers.codingChanged ?? []), ...(answers.slips ?? [])]) if (vendorById.get(g.vendorId)) mention(vendorById.get(g.vendorId).name.split(' ').slice(0, 2).join(' '), `knows for ${g.id}`);
  for (const g of answers.duplicateBills ?? []) if (billById.get(g.billIds[0])) mention(billById.get(g.billIds[0]).number, `knows for ${g.id}`);

  // ---- text that reads like an instruction ----
  for (const g of answers.injections ?? []) {
    const where = `injections ${g.id}`;
    const [kind, id, part, index] = g.ref.split(':');
    let actual;
    if (kind === 'vendor') actual = vendor(id, where)?.name;
    else if (kind === 'bill') actual = part === 'line' ? billById.get(id)?.lines[Number(index)]?.description : billById.get(id)?.note;
    else if (kind === 'expense') actual = part === 'line' ? expenseById.get(id)?.lines[Number(index)]?.description : expenseById.get(id)?.note;
    else fail(`${where}: unknown ref ${g.ref}`);
    if (actual === undefined) fail(`${where}: ${g.ref} does not exist`);
    else if (actual !== g.text) fail(`${where}: the text is not what ${g.ref} holds`);
    if (kind === 'bill' && billById.get(id) && !(billById.get(id).date >= since)) fail(`${where}: that bill is outside the window`);
  }

  // ---- the same bill entered twice ----
  for (const g of answers.duplicateBills ?? []) {
    const where = `duplicateBills ${g.id}`;
    const bills = g.billIds.map((id) => bill(id, where)).filter(Boolean);
    if (bills.length < 2) fail(`${where}: needs two or more bills`);
    else {
      const first = bills[0];
      for (const b of bills) {
        if (!first.number || b.number !== first.number) fail(`${where}: invoice numbers differ`);
        if (b.totalMinor !== first.totalMinor) fail(`${where}: totals differ`);
        const sameVendor = b.vendorId === first.vendorId || (sameGroups.has(b.vendorId) && sameGroups.get(b.vendorId) === sameGroups.get(first.vendorId));
        if (!sameVendor) fail(`${where}: not the same vendor`);
        if (Math.abs((Date.parse(b.date) - Date.parse(first.date)) / 86400000) > 14) fail(`${where}: dated more than two weeks apart`);
      }
    }
  }
}
