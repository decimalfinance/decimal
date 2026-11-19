// A bill goes from review to approved. Decimal's core journey, as the people do it.
// Proves: a clerk uploads a bill, picks a Category for every line and sends it for
// approval; an approver sees it waiting on them and approves; the clerk then sees it
// approved; and what was stored agrees (approved, each line keeps the Category picked).
//
// The journey the product takes on a freshly seeded team (seen 2026-11-20):
// - The PDF is addressed to "Testing Labs", not the seeded team's name, so the bill
//   opens with the "Addressed to Testing Labs" finding and Send for approval stays
//   off until it is settled. Settling it ("This is us") needs an admin, so Omar does
//   that; a clerk's buttons stay greyed. The buttons also stay greyed until the
//   Decimal agent has finished checking the name, which is a model call.
// - No approval rules are published, so the built-in route applies: one step, any
//   TWO of Daniel, Priya, Ava and Omar (quorum, 2 of 4). Daniel's approval alone
//   leaves the bill in approval; Priya (second approver) is the second.
// - Once approved, the bill page reads Done / Approved. Nothing is posted: the team
//   has no QuickBooks or Xero connected.
//
// Known fault (2026-11-20, see synthetic_data/testbench/reports/flow-bill-to-approval.md):
// once approved, the bill moves to the Release stage (bucket to_pay), which waits
// on everyone who didn't approve, Lena the viewer included. Payment release is
// frozen, so it never moves on, and the Bills list shows it to Maya as "Your
// approval", waiting on her and overdue. How an approved bill should read while
// payments are frozen is a product decision. The flow records what the list says
// in its result; flip LIST_FAULT_KNOWN to false once decided, and it becomes a check.
//
// Needs an empty team, because an empty Bills page uploads on drop:
//   node scripts/drive/drive.mjs seed
//   node scripts/drive/drive.mjs run scripts/drive/flows/bill-to-approval.mjs --team <that team>
// About 25-60 s: the model reads the PDF (6-30 s), then the agent checks the name.
const PDF = 'synthetic_data/invoices/A-routing/A3-first-bill-312.pdf';
const BILL_PAGE = /\/bills\/([0-9a-f-]{36})/;
const LIST_FAULT_KNOWN = true;
// One per line, in order. Mostly not what the model guesses, so a stored value
// that matches can only have come from Maya's pick.
const PICKS = ['Office supplies & software', 'Equipment rental', 'Job supplies', 'Other business expenses'];

// Wait until a button with exactly these words can be pressed (not disabled, not aria-disabled).
const pressable = (d, words, timeout) =>
  d.page.waitForFunction(
    (w) =>
      [...document.querySelectorAll('button')].some(
        (b) => b.innerText.replace(/\s+/g, ' ').trim() === w && !b.disabled && b.getAttribute('aria-disabled') !== 'true',
      ),
    { timeout, polling: 250 },
    words,
  );

// Poll the stored bill until a condition holds, so a check never races a save.
async function storedWhen(d, billId, ok, timeout = 15_000) {
  const began = Date.now();
  for (;;) {
    const { data } = await d.api('GET', `bills/${billId}/detail`);
    if (ok(data) || Date.now() - began > timeout) return data;
    await d.wait(500);
  }
}

const says = (screen, re) => re.test(screen.text);

export default async function billToApproval(d) {
  // 1. Maya uploads the bill on the Bills page and it opens in review.
  await d.as('maya');
  await d.goto('bills');
  await d.upload(PDF);
  await d.see('$312.40', { timeout: 120_000 });
  if (!BILL_PAGE.test(d.page.url())) await d.click('$312.40');
  await d.waitUrl(BILL_PAGE);
  await d.see('In review');
  const billId = d.page.url().match(BILL_PAGE)[1];
  const billRoute = `bills/${billId}`;

  // The finding about who the bill is addressed to: an admin settles it.
  const opened = await d.read();
  const { data: fresh } = await d.api('GET', `bills/${billId}/detail`);
  const addressedElsewhere =
    says(opened, /addressed to testing labs/i) ||
    (fresh.draft.workLog ?? []).some((e) => e.kind === 'flag_raised' && /addressed to/i.test(e.text));
  if (addressedElsewhere) {
    await d.as('omar');
    await d.goto(billRoute);
    await pressable(d, 'This is us', 120_000);
    await d.click('This is us');
    await d.click('Yes, record it');
    await d.see('Testing Labs is a name we trade under');
    await d.as('maya');
    await d.goto(billRoute);
  }

  // Maya picks a Category for every line.
  const chips = await d.page.$$('main [aria-haspopup="listbox"]');
  d.check(chips.length === 4, `${chips.length} Category pickers on the bill, expected 4`);
  for (let i = 0; i < PICKS.length; i++) {
    const chip = (await d.page.$$('main [aria-haspopup="listbox"]'))[i];
    await chip.click();
    await d.fill('Find a category', PICKS[i]);
    await d.click(PICKS[i], { within: '[role=listbox]', exact: true });
  }
  const picked = await storedWhen(d, billId, (x) => x.draft.lines.every((l, i) => l.category === PICKS[i]));
  d.check(
    picked.draft.lines.every((l, i) => l.category === PICKS[i]),
    `before sending, stored Categories are ${picked.draft.lines.map((l) => l.category).join(' | ')}`,
  );
  await d.shot('maya-picked-categories');

  // Maya sends it for approval.
  await pressable(d, 'Send for approval', 60_000);
  await d.click('Send for approval');
  await d.see('In approval');
  const sent = await d.read();
  d.check(says(sent, /in approval/i) && says(sent, /sent for approval/i), `after sending, Maya's bill page says: ${sent.text.slice(0, 160)}`);
  const routed = await storedWhen(d, billId, (x) => x.approval?.steps?.length > 0);
  const pool = (routed.approval?.steps ?? []).map((s) => s.person.name);
  const required = routed.approval?.steps?.[0]?.required;
  d.check(pool.includes('Daniel Brooks'), `the route waits on ${pool.join(', ')} (${required} needed); Daniel is ${pool.includes('Daniel Brooks') ? '' : 'not '}on it`);
  await d.shot('maya-sent');

  // 2. Daniel sees it waiting on him and approves.
  await d.as('daniel');
  await d.goto('inbox');
  await d.see('JOS-1147');
  const inbox = await d.read();
  d.check(says(inbox, /JOS-1147[\s\S]*approve[\s\S]*sent it for your approval/i), `Daniel's Inbox shows: ${inbox.text.slice(0, 220)}`);
  await d.click('JOS-1147');
  await d.waitUrl(billId);
  await pressable(d, 'Approve', 15_000);
  const before = await d.read();
  d.check(says(before, /waiting on you/i) && before.buttons.includes('Approve'), `Daniel's bill page says "${(before.text.match(/IN APPROVAL[^$]*/i) ?? [''])[0].trim()}" with buttons ${before.buttons.filter((b) => /approve|send back/i.test(b)).join(', ')}`);
  await d.shot('daniel-waiting-on-you');
  await d.click('Approve');
  const afterDaniel = await storedWhen(d, billId, (x) => x.approval?.steps?.some((s) => s.person.name === 'Daniel Brooks' && s.state === 'done'));
  const danielStep = afterDaniel.approval?.steps?.find((s) => s.person.name === 'Daniel Brooks');
  d.check(danielStep?.state === 'done', `Daniel's approval is stored as ${danielStep?.state}`);

  // The built-in route needs two: Priya is the second.
  if (afterDaniel.approval?.macroState !== 'approved') {
    await d.as('priya');
    await d.goto(billRoute);
    await pressable(d, 'Approve', 15_000);
    await d.click('Approve');
    await storedWhen(d, billId, (x) => x.approval?.macroState === 'approved');
  }

  // 3. Maya sees it approved.
  await d.as('maya');
  await d.goto(billRoute);
  await d.see('Approved');
  const done = await d.read();
  d.check(says(done, /done\s*·\s*approved/i), `Maya's bill page says: ${done.text.slice(0, 120)}`);
  await d.shot('maya-sees-approved');

  // 4. What was stored agrees.
  const { data } = await d.api('GET', `bills/${billId}/detail`);
  d.check(data.approval?.macroState === 'approved' && data.status?.macroState === 'approved', `stored approval is ${data.approval?.macroState}, status ${data.status?.macroState}`);
  const stored = data.draft.lines.map((l) => `${l.category} (by ${l.categoryConfirmedBy?.name ?? 'nobody'})`);
  d.check(
    data.draft.lines.length === 4 && data.draft.lines.every((l, i) => l.category === PICKS[i] && l.categoryConfirmedBy?.name === 'Maya Ortiz'),
    `stored lines: ${stored.join(' | ')}`,
  );

  // Maya's Bills list: see LIST_FAULT_KNOWN above.
  await d.goto('bills');
  await d.see('JOS-1147');
  const list = await d.read();
  const row = (list.text.match(/JOS-1147.*$/) ?? [''])[0];
  const listSaysDone = /approved|done/i.test(row) && /DONE\s+1/.test(list.text);
  await d.shot('maya-bills-list');
  if (!LIST_FAULT_KNOWN) d.check(listSaysDone, `Maya's Bills list row: ${row}`);

  return {
    billId,
    link: d.url(billRoute),
    addressedElsewhere,
    approvers: pool,
    required,
    approvedBy: data.approval.steps.filter((s) => s.state === 'done').map((s) => s.person.name),
    categories: data.draft.lines.map((l) => l.category),
    billsListRow: row,
    billsListSaysDone: listSaysDone,
  };
}
