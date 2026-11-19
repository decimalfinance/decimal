// A rejected bill goes back to review and is never a dead end.
// Maya (bill clerk) uploads a clean bill, picks a Category for every line and
// sends it for approval. Daniel, one of the approvers it waits on, sends it back
// with a reason. Maya finds it in review again, sees who sent it back and why,
// and sends it for approval again; it is waiting on its approvers once more.
// Each step is read back from what was stored, not only from the screen.
//
// What the product does on a freshly seeded team (followed here, not worked around):
// - The default approval rule routes a bill this size to ONE step: any two of
//   Ava, Daniel, Omar and Priya. Daniel is one of the four, so he can send it back,
//   and a single send-back stops the whole step.
// - The test PDF is addressed to "Testing Labs", not the seeded team's name, so the
//   bill opens with an "Addressed to Testing Labs" finding that blocks sending it on.
//   Only an admin can answer it, so Omar (admin) answers "This is us" first.
// - The reject action is labelled "Send back"; re-sending is "Send for approval again".
//
// Needs a team seeded just for it (it uploads its own bill and records a trading name):
//   node scripts/drive/drive.mjs seed && node scripts/drive/drive.mjs run scripts/drive/flows/rejected-goes-back.mjs
// About 20 s (19.8-20.1 s on the bench, 2026-11-20); 6-30 s of any run is the model reading the PDF.
const PDF = 'synthetic_data/invoices/A-routing/A3-first-bill-312.pdf';
const BILL_PAGE = /\/bills\/([0-9a-f-]{36})/;
const CATEGORY = 'Office supplies & software';
const REASON = 'Toner was returned. Take line 2 off before this is approved.';
const LINES = 4;

// Wait until a button with these exact words is on screen and enabled.
async function enabled(d, words, timeout = 60_000) {
  await d.page.waitForFunction(
    (w) => [...document.querySelectorAll('button')].some((b) => b.textContent.replace(/\s+/g, ' ').trim() === w && !b.disabled),
    { timeout },
    words,
  );
}

const detail = async (d, billId) => (await d.api('GET', `bills/${billId}/detail`)).data;
const currentApprovers = (data) => (data.approval?.steps ?? []).filter((s) => s.state === 'current').map((s) => s.person.name);

export default async function rejectedGoesBack(d) {
  // 1. Maya uploads the bill and it opens in review.
  await d.as('maya');
  await d.goto('bills');
  await d.see('Drop your first bill here');
  await d.upload(PDF);
  await d.see('$312.40', { timeout: 120_000 });
  if (!BILL_PAGE.test(d.page.url())) await d.click('$312.40');
  await d.waitUrl(BILL_PAGE);
  await d.see('In review');
  const billId = d.page.url().match(BILL_PAGE)[1];
  const billRoute = `bills/${billId}`;

  // The bill is addressed to "Testing Labs": Omar (admin) records it as a name the team trades under.
  await d.as('omar');
  await d.goto(billRoute);
  await d.see('Addressed to Testing Labs');
  await enabled(d, 'This is us');
  await d.click('This is us');
  await d.click('Yes, record it');
  await d.see('Testing Labs is a name we trade under');

  // Maya picks a Category on every line, from the menu, as a person does.
  await d.as('maya');
  await d.goto(billRoute);
  await d.see('In review');
  const cells = '.bp-cat[aria-haspopup=listbox]';
  const cellCount = (await d.page.$$(cells)).length;
  d.check(cellCount === LINES, `${cellCount} Category pickers on the bill, expected ${LINES}`);
  for (let i = 0; i < cellCount; i++) {
    const cell = (await d.page.$$(cells))[i];
    await cell.click();
    await d.click(CATEGORY, { within: '.bp-catmenu', exact: true });
  }
  await d.see('All changes saved');
  const picked = await detail(d, billId);
  const pickedLines = picked.draft.lines.map((l) => `${l.category} by ${l.categoryConfirmedBy?.name ?? l.categoryConfirmedBy ?? 'nobody'}`);
  d.check(
    picked.draft.lines.length === LINES && pickedLines.every((l) => l === `${CATEGORY} by Maya Ortiz`),
    `stored Category per line after Maya's picks: ${pickedLines.join('; ')}`,
  );

  // Maya sends it for approval.
  await enabled(d, 'Send for approval');
  await d.click('Send for approval');
  await d.see('In approval');
  await d.shot('sent-for-approval');
  const sent = await detail(d, billId);
  d.check(
    sent.draft.state === 'submitted' && sent.approval?.macroState === 'pending_approval',
    `after sending, stored state is ${sent.draft.state}, approval is ${sent.approval?.macroState}`,
  );
  const firstWaiting = currentApprovers(sent);
  d.check(firstWaiting.includes('Daniel Brooks'), `after sending, it waits on ${firstWaiting.join(', ') || 'nobody'}`);

  // 2. Daniel sends it back with a reason.
  await d.as('daniel');
  await d.goto(billRoute);
  await d.see('Your turn');
  await d.click('Send back');
  await d.fill('Why send it back?', REASON);
  await d.click('Send back', { nth: 2 });
  await d.see('Sent back');
  await d.shot('daniel-sent-it-back');

  // 3. Maya finds it back in review, sees who sent it back and why, and can work on it.
  await d.as('maya');
  await d.goto(billRoute);
  await d.see('In review');
  await d.see(`Daniel Brooks: ${REASON}`);
  const back = await d.read();
  await d.shot('back-in-review-for-maya');
  d.check(
    /IN REVIEW · SENT BACK/i.test(back.text) && back.text.includes(`Daniel Brooks: ${REASON}`),
    `Maya's bill page shows "${(back.text.match(/IN REVIEW[^$]*/i)?.[0] ?? '').trim()}" and "${back.text.includes(REASON) ? `Daniel Brooks: ${REASON}` : 'no reason'}"`,
  );
  d.check(back.buttons.includes('Send for approval again'), `Maya's buttons: ${back.buttons.slice(-4).join(', ')}`);
  d.check(back.fields.some((f) => f.label === 'Total due'), `Maya's bill page has ${back.fields.length} editable fields, Total due among them: ${back.fields.some((f) => f.label === 'Total due')}`);

  // What was stored after the send-back: back in review, editable, not closed.
  const rejected = await detail(d, billId);
  d.check(
    rejected.draft.state === 'draft' && rejected.draft.readOnly === false && !rejected.closed,
    `after the send-back, stored state is ${rejected.draft.state}, read-only ${rejected.draft.readOnly}, closed ${JSON.stringify(rejected.closed ?? null)}`,
  );
  d.check(
    rejected.status?.subStatus?.text === 'Sent back for changes',
    `after the send-back, the bill's status reads "${rejected.status?.subStatus?.text}"`,
  );
  d.check(
    rejected.draft.sentBack?.byName === 'Daniel Brooks' && rejected.draft.sentBack?.reason === REASON,
    `stored send-back is by ${rejected.draft.sentBack?.byName} with reason "${rejected.draft.sentBack?.reason}"`,
  );
  const keptLines = rejected.draft.lines.map((l) => `${l.category} by ${l.categoryConfirmedBy?.name ?? l.categoryConfirmedBy ?? 'nobody'}`);
  d.check(
    keptLines.length === LINES && keptLines.every((l) => l === `${CATEGORY} by Maya Ortiz`),
    `after the send-back, Maya's Categories are still stored: ${keptLines.join('; ')}`,
  );
  const declined = (rejected.approval?.steps ?? []).find((s) => s.state === 'declined');
  d.check(
    declined?.person.name === 'Daniel Brooks' && declined?.declineReason === REASON,
    `stored approval records ${declined?.person.name ?? 'nobody'} declining, reason "${declined?.declineReason}"`,
  );

  // 4. Maya sends it for approval again, and it is waiting on its approvers again.
  await d.click('Send for approval again');
  await d.see('In approval');
  await d.shot('sent-again');
  const again = await detail(d, billId);
  d.check(
    again.draft.state === 'submitted' && again.approval?.macroState === 'pending_approval',
    `after re-sending, stored state is ${again.draft.state}, approval is ${again.approval?.macroState}`,
  );
  const waitingAgain = currentApprovers(again);
  d.check(
    waitingAgain.includes('Daniel Brooks') && waitingAgain.length === firstWaiting.length,
    `after re-sending, it waits on ${waitingAgain.join(', ') || 'nobody'} (first time: ${firstWaiting.join(', ')})`,
  );

  // Daniel sees it is his turn again.
  await d.as('daniel');
  await d.goto(billRoute);
  await d.see('Your turn');
  const danielAgain = await d.read();
  d.check(danielAgain.buttons.includes('Approve') && danielAgain.buttons.includes('Send back'), `Daniel's buttons on the re-sent bill: ${danielAgain.buttons.slice(-4).join(', ')}`);

  return {
    billId,
    link: d.url(billRoute),
    waitingFirst: firstWaiting,
    waitingAgain,
    categoriesAfterPick: pickedLines,
    categoriesAfterSendBack: keptLines,
  };
}
