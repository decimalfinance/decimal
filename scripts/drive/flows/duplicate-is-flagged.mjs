// A duplicate is flagged. A clerk uploads the same Juniper Office Supply invoice
// (JOS-1147, $312.40) twice; Decimal holds both bills as a possible duplicate of
// each other until an admin decides, and the decision is the record.
// Proves:
//   1. both uploads become bills (two bills, same vendor, number and total);
//   2. each is flagged as a possible duplicate of the other, stored and shown on
//      the bill page;
//   3. while the flag is open the bill can't be sent for approval: the button is
//      off on the page and the server refuses a send;
//   4. an admin clears it on one bill with a reason, and the pair is settled:
//      neither bill is blocked, and the page says who decided and why. Known gap
//      (2026-11-20): only the cleared bill shows and stores the reason; the other
//      bill's History says "Ava Chen settled Possible duplicate" with no reason,
//      so the flow holds the other bill to who, not why;
//   5. what was stored agrees, before and after.
//
// Setup, the way a person would do it:
//   - The second upload is A3 resent: the same PDF with different bytes (a line
//     appended after %%EOF, written under .bench/drive/ at run time). Uploading the
//     identical file again does not make a second bill, by design: intake dedupes
//     on the file's sha256 and tells the person "This file is already in Decimal".
//   - Every synthetic invoice is addressed to "Testing Labs", which a seeded team
//     is not, so Ava settles that finding with "This is us" before the second
//     upload. Otherwise the duplicate would never be the only thing holding the
//     bill, and claims 3 and 4 would prove nothing.
//
// The exception agent: it investigates the pair and may show a recommendation
// on the flag (verdict, comparison table, "Close as a duplicate" emphasised).
// This flow tolerates it ready, pending or absent and reads none of its words.
// What its presence changes for a person: when its comparison finds every figure
// identical, the "Not a duplicate" form adds a warning ("Every figure on these
// two bills matches. Clearing this means both can be approved and posted.").
// The choices themselves are the same: Not a duplicate (admin, with a reason),
// Close as a duplicate (admin), or ask someone.
//
// Needs a team seeded for it (it uploads onto an empty Bills page):
//   node scripts/drive/drive.mjs seed
//   node scripts/drive/drive.mjs run scripts/drive/flows/duplicate-is-flagged.mjs --team <that team>
// About 30 to 60 s, most of it the model reading the PDF twice.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PDF = 'synthetic_data/invoices/A-routing/A3-first-bill-312.pdf';
// Its own folder per run, so two agents verifying at once never share the file.
const RESENT = `.bench/drive/resent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}/JOS-1147-juniper.pdf`;
const REASON = 'Two separate orders, confirmed with the vendor.';
const BILL_PAGE = /\/bills\/([0-9a-f-]{36})/;
const READ_TIMEOUT = 150_000;

const dupFlag = (flags) => (flags ?? []).find((f) => f.kind === 'possible_duplicate');
const blockers = (flags) => (flags ?? []).filter((f) => f.blocking).map((f) => f.kind);

// Is the page's Send for approval button there, and on?
const sendButton = (d) => d.page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Send for approval');
  return b ? { present: true, enabled: !b.disabled && b.getAttribute('aria-disabled') !== 'true' } : { present: false, enabled: false };
});

// Poll the stored bill until test(detail) holds, or give up and return the last read.
async function waitStored(d, billId, test, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await d.api('GET', `bills/${billId}/detail`);
    if (data?.draft && test(data.draft)) return data.draft;
    if (Date.now() > until) return data?.draft ?? null;
    await d.wait(1500);
  }
}

export default async function duplicateIsFlagged(d) {
  mkdirSync(path.dirname(path.join(ROOT, RESENT)), { recursive: true });
  writeFileSync(path.join(ROOT, RESENT), Buffer.concat([readFileSync(path.join(ROOT, PDF)), Buffer.from('\n% sent again\n')]));

  // First upload: an empty Bills page uploads on drop and opens the bill.
  await d.as('maya');
  await d.goto('bills');
  await d.see('Drop your first bill here');
  await d.upload(PDF);
  await d.see('$312.40', { timeout: READ_TIMEOUT });
  if (!BILL_PAGE.test(d.page.url())) await d.click('$312.40');
  await d.waitUrl(BILL_PAGE);
  const first = d.page.url().match(BILL_PAGE)[1];

  // Setup: Ava says the invoice's addressee is us, so only the duplicate can hold the bills.
  await d.as('ava');
  await d.goto(`bills/${first}`);
  await d.see('JOS-1147');
  await d.click('This is us');
  await d.click('Yes, record it');
  const settled = await waitStored(d, first, (b) => !blockers(b.flags).includes('addressed_elsewhere'), 15_000);
  d.check(settled && blockers(settled.flags).length === 0,
    `setup: after "This is us" the first bill's blocking flags are [${blockers(settled?.flags)}], expected none`);

  // Second upload: a page with bills uses Upload a bill, then the dialog's button.
  await d.as('maya');
  await d.goto('bills');
  await d.click('Upload a bill');
  await d.upload(RESENT);
  await d.click('Upload 1 file');
  const deadline = Date.now() + READ_TIMEOUT;
  let bills = [];
  for (;;) {
    bills = (await d.api('GET', 'bills/workbench')).data?.bills ?? [];
    const second = bills.find((b) => b.paymentOrderId !== first);
    if (second && second.invoiceNumber && dupFlag(second.flags)) break;
    if (Date.now() > deadline) break;
    await d.wait(2000);
  }
  const second = bills.find((b) => b.paymentOrderId !== first)?.paymentOrderId;

  // 1. Both uploads became bills.
  const juniper = bills.filter((b) => b.vendorName === 'Juniper Office Supply' && b.invoiceNumber === 'JOS-1147' && Math.round(b.amountUsd * 100) === 31240);
  d.check(bills.length === 2 && juniper.length === 2 && !!second,
    `1. ${bills.length} bills stored, ${juniper.length} of them Juniper Office Supply JOS-1147 $312.40; expected 2 and 2`);
  await d.goto('bills');
  await d.see('ALL 2');
  await d.shot('bills-two');

  // 2. Flagged as a possible duplicate of each other: stored, then on the page.
  const before = {};
  for (const [id, other] of [[first, second], [second, first]]) {
    const b = await waitStored(d, id, (x) => !!dupFlag(x.flags), 15_000);
    before[id] = b;
    const f = dupFlag(b?.flags);
    const target = f?.resolutions?.find((r) => r.action === 'clear_duplicate')?.targetId;
    d.check(!!f && f.blocking && target === other,
      `2. stored: bill ${id.slice(0, 8)} has possible_duplicate=${!!f}, blocking=${f?.blocking}, points at ${target?.slice(0, 8)}; expected the other bill ${other.slice(0, 8)}`);
  }
  await d.goto(`bills/${second}`);
  await d.see('Possible duplicate');
  const page2 = await d.read();
  d.check(/Possible duplicate/.test(page2.text) && page2.buttons.includes('Not a duplicate'),
    `2. shown: "Possible duplicate" on the bill page=${/Possible duplicate/.test(page2.text)}, its choices: ${page2.buttons.filter((b) => /duplicate/i.test(b)).join(' | ')}`);
  await d.shot('flag-on-bill');

  // 3. While the flag is open the bill can't be sent for approval.
  d.check(JSON.stringify(blockers(before[second].flags)) === '["possible_duplicate"]',
    `3. the only thing blocking the bill is [${blockers(before[second].flags)}]`);
  const sendBefore = await sendButton(d);
  d.check(sendBefore.present && !sendBefore.enabled && /Settle the finding to send it on/.test(page2.text),
    `3. page: Send for approval present=${sendBefore.present} enabled=${sendBefore.enabled}, "Settle the finding to send it on" shown=${/Settle the finding to send it on/.test(page2.text)}`);
  const tried = await d.api('POST', `bills/${second}/confirm-as-read`, {});
  const stillDraft = await waitStored(d, second, () => true, 0);
  d.check(!tried.ok && stillDraft?.state === 'draft',
    `3. server: a send as Maya answered ${tried.status} and the bill is ${stillDraft?.state}; expected a refusal and draft`);

  // 4. Ava (admin) clears the flag on the second bill with a reason.
  await d.as('ava');
  await d.goto(`bills/${second}`);
  await d.see('Possible duplicate');
  await d.click('Not a duplicate');
  await d.fill('Your reason, in one line', REASON);
  await d.click('Not a duplicate', { nth: 1 });
  await d.see(REASON, { timeout: 15_000 });
  const after = {};
  for (const id of [second, first]) {
    after[id] = await waitStored(d, id, (x) => blockers(x.flags).length === 0, 15_000);
  }
  for (const id of [second, first]) {
    const cleared = id === second;
    await d.goto(`bills/${id}`);
    await d.see('JOS-1147');
    let screen = await d.read();
    if (!/Ava Chen (cleared|settled)/.test(screen.text)) {
      await d.click('Fold or open History');
      await d.see('Ava Chen');
      screen = await d.read();
    }
    const send = await sendButton(d);
    const who = cleared ? /Ava Chen/.test(screen.text) : /Ava Chen settled Possible duplicate/.test(screen.text);
    const why = screen.text.includes(REASON);
    // Known gap (2026-11-20): the other bill of the pair says who settled it but
    // not why. Only the cleared bill is held to showing the reason.
    d.check(who && (why || !cleared) && send.present && send.enabled,
      `4. ${cleared ? 'cleared' : 'other'} bill page: who shown=${who}, reason shown=${why}, Send for approval enabled=${send.enabled}`);
    await d.shot(cleared ? 'cleared-bill' : 'other-bill-settled', { full: true });
  }

  // 5. What was stored agrees: open and blocking before, not blocking after, and History records the decision.
  for (const id of [second, first]) {
    const cleared = id === second;
    const b = after[id];
    const f = dupFlag(b?.flags);
    d.check(dupFlag(before[id].flags)?.blocking === true && (!f || !f.blocking) && blockers(b?.flags).length === 0 && b?.state === 'draft',
      `5. stored on ${cleared ? 'cleared' : 'other'} bill: duplicate flag before blocking=${dupFlag(before[id].flags)?.blocking}, after ${f ? `present, blocking=${f.blocking}` : 'gone'}, blockers [${blockers(b?.flags)}], state ${b?.state}`);
    const log = b?.workLog ?? [];
    const settledBy = log.find((e) => e.kind === 'flag_cleared' && /Possible duplicate/.test(e.text ?? ''))?.byName;
    const override = log.find((e) => e.kind === 'policy_overridden' && (e.text ?? '').includes(REASON));
    d.check(settledBy === 'Ava Chen' && (!cleared || override?.byName === 'Ava Chen'),
      `5. stored on ${cleared ? 'cleared' : 'other'} bill: duplicate settled by ${settledBy ?? 'nobody'}, reason recorded by ${override?.byName ?? 'nobody'}`);
  }

  const brief = dupFlag(before[second].flags)?.brief;
  return {
    bills: [first, second],
    agent: brief ? `${brief.status}${brief.verdict ? `, ${brief.verdict}` : ''}` : 'none',
    links: [first, second].map((id) => d.url(`bills/${id}`)),
  };
}
