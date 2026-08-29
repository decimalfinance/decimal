import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesLookRelated, evaluateBillFlags, summarizeBillFlags } from '../src/payments/bill-flags.js';
import { pickAddressConfidenceKey } from '../src/payments/bills.js';

// The "addressed to someone else" gate. Getting this wrong in the permissive
// direction means a bill made out to another company passes review silently,
// so the false-negative cases below matter more than the false-positive ones.
//
// Regression: "Decimal Labs" vs "Halcyon Labs, Inc." was treated as related
// because both contain "labs" — a real misaddressed bill reached review with
// no flag at all.

test('a bill addressed to a different company is not treated as related', () => {
  assert.equal(namesLookRelated('Halcyon Labs, Inc.', 'Decimal Labs'), false);
  assert.equal(namesLookRelated('Halcyon Labs, Inc.', 'acme corp'), false);
  assert.equal(namesLookRelated('Northwind Trading', 'Acme Corporation'), false);
});

test('generic industry words alone never make two companies related', () => {
  for (const [a, b] of [
    ['Alpha Technologies', 'Beta Technologies'],
    ['Foo Systems Inc', 'Bar Systems LLC'],
    ['One Global Solutions', 'Two Global Solutions'],
    ['Redwood Digital Studio', 'Bluepeak Digital Studio'],
  ] as const) {
    assert.equal(namesLookRelated(a, b), false, `${a} vs ${b} should NOT look related`);
  }
});

test('the same company in different dress still matches', () => {
  assert.equal(namesLookRelated('Acme Corp', 'acme corp'), true);
  assert.equal(namesLookRelated('Acme Corporation Ltd', 'Acme'), true);
  assert.equal(namesLookRelated('Decimal Labs, Inc.', 'Decimal Labs'), true);
  assert.equal(namesLookRelated('Northwind Trading Co.', 'Northwind Trading'), true);
});

test('when nothing distinctive remains, stay quiet rather than cry wolf', () => {
  // Both sides reduce to noise — we genuinely cannot tell, and a false alarm
  // on every bill would train people to click through the real ones.
  assert.equal(namesLookRelated('Labs Inc', 'Labs LLC'), true);
  assert.equal(namesLookRelated('', 'Acme'), true);
});

// --- the flags themselves -----------------------------------------------
//
// These exist because the bug was never a missing check. The check was there;
// the workbench just never asked. Both surfaces now call evaluateBillFlags, so
// what is asserted here is what BOTH screens show.

const baseFacts = {
  vendorName: 'Acme Cloud Services, Inc.',
  organizationName: 'Decimal Labs',
  tradingNames: [] as string[],
  amountRaw: 4_820_000_000n,
  billToName: null,
  triggeredRules: [] as string[],
  vendorHold: null,
  ceilingMinor: null,
  duplicates: [],
  similarVendors: [],
  priorBillsFromVendor: 0,
  duplicateOverride: null,
  shortPay: null,
  amounts: { lineItemsTotal: null, subtotal: null, tax: null, total: null },
  planAlerts: [] as string[],
  documentType: { invoiceNumber: null as string | null, lineInvoiceRefs: [] as string[] },
};

test('a bill addressed to another company is flagged, danger, and blocking', () => {
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Halcyon Labs, Inc.' });
  const flag = flags.find((f) => f.kind === 'addressed_elsewhere');
  assert.ok(flag, 'expected an addressed_elsewhere flag');
  assert.equal(flag.severity, 'danger');
  assert.equal(flag.blocking, true);
  assert.match(flag.message, /Halcyon Labs, Inc\./);
  assert.equal(summarizeBillFlags(flags).blocking, true);
});

test('a bill addressed to us raises nothing', () => {
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Decimal Labs, Inc.' });
  assert.deepEqual(flags, []);
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

test('the worst flag comes first, so a one-line row shows the worst thing', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    triggeredRules: ['unreviewed_counterparty'],
  });
  // new_vendor is info and would otherwise sort first by insertion order.
  assert.equal(flags[0]!.severity, 'danger');
  assert.equal(summarizeBillFlags(flags).worst!.kind, 'addressed_elsewhere');
  assert.equal(summarizeBillFlags(flags).dangerCount, 1);
});

test('every flag carries a short form a table row can render', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    triggeredRules: ['known_counterparty_wallet_changed', 'invalid_extracted_wallet_address', 'unreviewed_counterparty'],
    ceilingMinor: 1_000_000n,
  });
  assert.ok(flags.length >= 4);
  for (const f of flags) {
    assert.ok(f.short.length > 0 && f.short.length <= 40, `bad short form: "${f.short}"`);
    assert.ok(f.message.length > f.short.length);
  }
});

test('an info-only flag never blocks the bill', () => {
  const flags = evaluateBillFlags({ ...baseFacts, triggeredRules: ['unreviewed_counterparty'] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.kind, 'new_vendor');
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

// --- arithmetic ---------------------------------------------------------------
//
// The cheapest gate we have and the only one that catches extraction being
// confidently wrong. Every case below asserts the dangerous bill is BLOCKED,
// not merely that a clean one passes — a gate that never refuses anything is
// decoration.

test('line items that do not add up to the document total block the bill', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_000, subtotal: null, tax: null, total: 4_820 },
  });
  const flag = flags.find((f) => f.kind === 'lines_do_not_sum');
  assert.ok(flag, 'a total the lines do not support must be flagged');
  assert.equal(flag.blocking, true);
  assert.equal(summarizeBillFlags(flags).blocking, true);
});

test('subtotal plus tax that does not equal the total blocks the bill', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: null, subtotal: 4_000, tax: 320, total: 4_820 },
  });
  const flag = flags.find((f) => f.kind === 'total_does_not_reconcile');
  assert.ok(flag, '4,000 + 320 is not 4,820 and must not pass silently');
  assert.equal(flag.blocking, true);
});

test('a bill whose figures reconcile raises nothing', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_500, subtotal: 4_500, tax: 320, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});

test('tax on a bill with no printed subtotal is not a mismatch', () => {
  // The commonest invoice in the world: three lines, a tax line, a total, and
  // no subtotal row. Comparing the lines against a tax-inclusive total made
  // every one of them read "lines do not add up" and blocked it — a false
  // alarm on ordinary paperwork, which is how a gate gets ignored.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_000, subtotal: null, tax: 320, total: 4_320 },
  });
  assert.deepEqual(flags, []);
});

test('the screen and the server ask the arithmetic question the same way', () => {
  // The draft screen has always checked `lines + tax` against the total. When
  // the server compared lines against the total with tax still in it, a person
  // could watch the on-screen warning clear and still be refused at Confirm
  // with no visible reason. Same numbers, same verdict, from both sides.
  const lines = 4_000, tax = 820, total = 4_820;
  const screenSaysOk = Math.abs(lines + tax - total) < 0.005;
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: lines, subtotal: null, tax, total },
  });
  assert.equal(screenSaysOk, true);
  assert.equal(flags.some((f) => f.kind === 'lines_do_not_sum'), false);
});

test('an arithmetic flag offers paying the itemised total, and anyone may decide it', () => {
  // The dead end this closes: "Correct the figures" assumes the reading was
  // wrong. When the document is the thing that is wrong, the ordinary answer is
  // to pay what it itemises — and that had no way to be said.
  for (const amounts of [
    { lineItemsTotal: 4_000, subtotal: null, tax: null, total: 4_820 },
    { lineItemsTotal: null, subtotal: 4_000, tax: 320, total: 4_820 },
  ]) {
    const flags = evaluateBillFlags({ ...baseFacts, amounts });
    const flag = flags.find((f) => f.blocking);
    assert.ok(flag, 'the bill is blocked');
    const pay = flag.resolutions.find((r) => r.action === 'pay_the_lines');
    assert.ok(pay, `${flag.kind} must offer paying the itemised total`);
    // Not admin-gated: the approval chain is the control, not this button.
    assert.equal(pay.requires, 'anyone');
  }
});

test('the recorded decision to short-pay replaces the flag that prompted it', () => {
  // Once the total matches the lines the discrepancy is gone, so the flag would
  // simply vanish — and an approver would see a bill for $4,000 against a
  // document printed at $4,820 with nothing saying why. The judgement has to
  // outlive the problem.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_000, subtotal: null, tax: 0, total: 4_000 },
    shortPay: {
      byName: 'Priya Raman',
      reason: 'Invoice does not add up; vendor asked for a corrected copy.',
      itemisedTotal: 4_000,
      documentTotal: 4_820,
    },
  });
  const flag = flags.find((f) => f.kind === 'short_paid');
  assert.ok(flag, 'the decision is shown');
  assert.equal(flag.blocking, false);
  assert.equal(flag.severity, 'info');
  assert.match(flag.message, /Priya Raman/);
  assert.match(flag.message, /\$4,820\.00/);
  assert.match(flag.message, /corrected copy/);
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

test('sub-cent rounding is not treated as disagreement', () => {
  // Invoices print to two decimals; a third-decimal remainder is arithmetic,
  // not a discrepancy, and flagging it would train people to ignore the flag.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_820.001, subtotal: 4_820, tax: 0, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});

test('missing figures are not mismatches', () => {
  // Plenty of real invoices carry no subtotal or tax line. Absence must stay
  // silent, or every simple invoice screams.
  for (const amounts of [
    { lineItemsTotal: null, subtotal: null, tax: null, total: 4_820 },
    { lineItemsTotal: null, subtotal: 4_820, tax: null, total: 4_820 },
    { lineItemsTotal: 4_820, subtotal: null, tax: null, total: null },
  ]) {
    assert.deepEqual(evaluateBillFlags({ ...baseFacts, amounts }), [], JSON.stringify(amounts));
  }
});

test('a line the model could not read stops the sum being trusted', () => {
  // If one line's total is unreadable, the remaining lines will not match the
  // document — and claiming a mismatch would be blaming the document for our
  // own gap. The check simply does not run.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: null, subtotal: 4_820, tax: 0, total: 4_820 },
  });
  assert.deepEqual(flags, []);
});

// --- weakened approval --------------------------------------------------------
//
// The routing an org configures is not always the routing that runs. This is
// the case where the engine did the right thing and told nobody.

test('a quorum the engine had to lower is surfaced, not swallowed', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    planAlerts: ['step 0 quorum lowered 2 → 1: not enough eligible approvers'],
  });
  const flag = flags.find((f) => f.kind === 'approval_weakened');
  assert.ok(flag, 'a 2-of-N that became 1-of-N must be visible to whoever signs');
  // The numbers, in a sentence an operator can act on — not the compiler's
  // "step 0 had no approvers after SoD/resolution", which is true and useless.
  assert.match(flag.message, /Signed by 1 instead of the 2/);
  assert.doesNotMatch(flag.message, /SoD|step \d|resolution/i, 'no internals leak into operator copy');
});

test('weakened approval warns but never blocks', () => {
  // The quorum was lowered precisely because nobody else could approve.
  // Blocking would recreate the deadlock it was lowered to avoid.
  const flags = evaluateBillFlags({
    ...baseFacts,
    planAlerts: ['step 0 quorum lowered 2 → 1: not enough eligible approvers'],
  });
  assert.equal(flags[0]!.blocking, false);
  assert.equal(summarizeBillFlags(flags).blocking, false);
});

test('routine compile notes are not dressed up as a warning', () => {
  // Only genuine weakening counts. Everything the compiler chatters about
  // must stay out, or the flag becomes noise and gets ignored.
  const flags = evaluateBillFlags({
    ...baseFacts,
    planAlerts: ['step "approval" resolved via seat ladder', 'policy v3 selected'],
  });
  assert.deepEqual(flags, []);
});

test('a danger still outranks a weakened quorum in the row summary', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    planAlerts: ['step 0 quorum lowered 2 → 1: not enough eligible approvers'],
  });
  assert.equal(summarizeBillFlags(flags).worst!.kind, 'addressed_elsewhere');
  assert.ok(flags.some((f) => f.kind === 'approval_weakened'), 'but the warning is still carried');
});

// --- trading names ------------------------------------------------------------
//
// The half that makes the flag worth keeping. A flag you can only dismiss is
// one you dismiss every month until you stop reading it.

test('a bill addressed to a name we trade under is not flagged', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    tradingNames: ['Halcyon Labs'],
  });
  assert.deepEqual(flags, [], 'once told Halcyon Labs is us, it must stop asking');
});

test('recording one name does not blunt the check for others', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Northwind Trading',
    tradingNames: ['Halcyon Labs'],
  });
  assert.ok(flags.some((f) => f.kind === 'addressed_elsewhere'),
    'a genuinely unrelated company must still be caught');
});

test('trading names are matched as loosely as the org name is', () => {
  // "Halcyon Labs" on file, "Halcyon Labs, Inc." on the invoice — the legal
  // suffix is noise here exactly as it is for the org's own name.
  for (const billTo of ['Halcyon Labs, Inc.', 'HALCYON LABS', 'Halcyon Labs LLC']) {
    assert.deepEqual(
      evaluateBillFlags({ ...baseFacts, billToName: billTo, tradingNames: ['Halcyon Labs'] }),
      [], billTo,
    );
  }
});

// --- no dead ends -------------------------------------------------------------
//
// The governing rule: it must be hard for a bill to FAIL — to reach a state
// with no exit. A flag that stops a bill and offers nothing is a dead end, and
// a bill stuck because nobody can resolve it fails as surely as one paid
// wrongly, just later and more confusingly. This is the invariant, asserted
// against every blocking flag the evaluator can produce rather than a list
// someone has to remember to update.

test('every blocking flag offers at least one way out', () => {
  const everyBadThing = evaluateBillFlags({
    ...baseFacts,
    billToName: 'Halcyon Labs, Inc.',
    triggeredRules: ['known_counterparty_wallet_changed', 'invalid_extracted_wallet_address', 'unreviewed_counterparty'],
    ceilingMinor: 1_000_000n,
    vendorHold: { status: 'blocked', reason: 'under review', byName: 'Zaid', at: new Date().toISOString() } as never,
    amounts: { lineItemsTotal: 4_000, subtotal: 4_000, tax: 0, total: 4_820 },
    planAlerts: ['step 0 quorum lowered 2 → 1: not enough eligible approvers'],
  });

  const blocking = everyBadThing.filter((f) => f.blocking);
  assert.ok(blocking.length >= 4, 'the fixture must actually produce blocking flags');
  for (const f of blocking) {
    assert.ok(f.resolutions.length > 0, `${f.kind} blocks the bill and offers no way forward`);
  }
});

test('asking is always available on a blocked bill', () => {
  // Asking is never the dangerous act, so it must never be the thing an
  // approver lacks the standing to do.
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Halcyon Labs, Inc.' });
  const ask = flags.find((f) => f.blocking)!.resolutions.find((r) => r.action === 'ask_someone');
  assert.ok(ask, 'every blocking flag can be asked about');
  assert.equal(ask.requires, 'anyone');
});

test('deciding another company is us is admin-only, and says it is permanent', () => {
  const flags = evaluateBillFlags({ ...baseFacts, billToName: 'Halcyon Labs, Inc.' });
  const flag = flags.find((f) => f.kind === 'addressed_elsewhere')!;
  const thisIsUs = flag.resolutions.find((r) => r.action === 'this_is_us')!;
  assert.equal(thisIsUs.requires, 'admin');
  assert.match(thisIsUs.detail, /Halcyon Labs, Inc\./, 'names the company being claimed');
  assert.match(thisIsUs.detail, /Permanent/i, 'and warns that it is not a one-off dismissal');
});

test('flags that are context rather than problems offer nothing', () => {
  const flags = evaluateBillFlags({ ...baseFacts, triggeredRules: ['unreviewed_counterparty'] });
  assert.equal(flags[0]!.kind, 'new_vendor');
  assert.deepEqual(flags[0]!.resolutions, [], 'there is nothing to resolve about a first bill');
});

// --- is it an invoice at all? -------------------------------------------------
//
// The two documents that look like invoices to anything asked to extract
// invoice fields, and the only flags here whose failure costs real money on the
// first occurrence rather than the tenth.

test('a document listing several invoice numbers is treated as a statement', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    documentType: { invoiceNumber: 'STMT-9', lineInvoiceRefs: ['INV-1001', 'INV-1002', 'INV-1003'] },
  });
  const flag = flags.find((f) => f.kind === 'looks_like_statement');
  assert.ok(flag, 'paying a statement pays every invoice on it a second time');
  assert.equal(flag.blocking, true);
  assert.match(flag.message, /INV-1001/);
});

test('a real invoice referencing one number is not a statement', () => {
  // An invoice may legitimately cite its own number, or a PO, in a line.
  const flags = evaluateBillFlags({
    ...baseFacts,
    documentType: { invoiceNumber: 'INV-20455', lineInvoiceRefs: ['INV-20455'] },
  });
  assert.deepEqual(flags, [], 'one reference is an invoice describing itself');
});

test('a credit-note series is not paid', () => {
  for (const n of ['CN-4471', 'CM 220', 'cn_88']) {
    const flags = evaluateBillFlags({ ...baseFacts, documentType: { invoiceNumber: n, lineInvoiceRefs: [] } });
    const flag = flags.find((f) => f.kind === 'looks_like_credit_note');
    assert.ok(flag, `${n} is a credit-note series`);
    assert.equal(flag.blocking, true);
  }
});

test('a negative total is a credit note whatever it is called', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: null, subtotal: null, tax: null, total: -820 },
  });
  const flag = flags.find((f) => f.kind === 'looks_like_credit_note');
  assert.ok(flag, 'money owed TO us must never be paid out');
  assert.match(flag.message, /negative/i);
});

test('ordinary invoice numbers are not mistaken for credit notes', () => {
  // The check keys on the SERIES, so an invoice number that merely starts with
  // those letters must not trip it.
  for (const n of ['CNC-1001', 'CONTRACT-42', 'INV-CN-9', 'C-1234']) {
    assert.deepEqual(
      evaluateBillFlags({ ...baseFacts, documentType: { invoiceNumber: n, lineInvoiceRefs: [] } }),
      [], n,
    );
  }
});

// --- which confidence governs which field -------------------------------------
//
// The address boxes sit under Vendor and fall back to the letterhead address
// when an invoice prints no Remit-To panel. They were still judged by the
// model's remitTo confidence — which, for a panel that is not on the page, is a
// hedge rather than a reading. Every bill came up amber for a value the model
// had read at 1.0, which teaches people to click through the amber.

test('a value read from the letterhead is judged on the letterhead read', () => {
  assert.equal(pickAddressConfidenceKey(true), 'vendorAddress',
    'showing the vendor address means asking how well the vendor address was read');
  assert.equal(pickAddressConfidenceKey(false), 'remitTo',
    'a real Remit-To panel is still judged as remitTo');
});

test('a document that is not an invoice is not held to an invoice\'s arithmetic', () => {
  // A credit note's figures are negative on the page; the extraction prompt
  // asks for a positive amount, which is right for the invoices that are almost
  // everything that arrives. So its line of -$240 got compared against a
  // sign-stripped $240 and reported as a document that disagrees with itself.
  // It does not. We stripped the sign.
  //
  // The deeper reason holds without that bug. These checks exist to stop a
  // wrong figure being PAID, and they offer "correct the figures" and "pay the
  // itemised total" to get there. On something nobody can pay, both answer a
  // question nobody asked — and the second, on a credit note, invites paying
  // minus four hundred and eighty dollars.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: -240, subtotal: null, tax: 0, total: 240 },
    documentType: { invoiceNumber: 'CN-0442', lineInvoiceRefs: [], declaredKind: 'credit_note' },
  });
  assert.equal(flags.some((f) => f.kind === 'lines_do_not_sum'), false);
  assert.equal(flags.some((f) => f.kind === 'total_does_not_reconcile'), false);
  // What it IS gets said, loudly, and still blocks.
  const credit = flags.find((f) => f.kind === 'looks_like_credit_note');
  assert.ok(credit);
  assert.equal(credit.blocking, true);
  // And nothing offers to pay it.
  for (const f of flags) {
    assert.equal(f.resolutions.some((r) => r.action === 'pay_the_lines'), false);
  }
});

test('an invoice is still held to its arithmetic', () => {
  // The suppression is scoped to what the document says it is, not to anything
  // that happens to have odd figures — an invoice that does not add up is the
  // whole reason these checks exist.
  const flags = evaluateBillFlags({
    ...baseFacts,
    amounts: { lineItemsTotal: 4_000, subtotal: null, tax: 0, total: 4_820 },
    documentType: { invoiceNumber: 'NW-3320', lineInvoiceRefs: [], declaredKind: 'invoice' },
  });
  assert.equal(flags.some((f) => f.kind === 'lines_do_not_sum'), true);
});

// --- a vendor we may already have, under another name ------------------------

test('a legal suffix is not a different company', async () => {
  const { normalizeVendorName } = await import('../src/payments/vendor-similarity.js');
  // The case that started this: an invoice from "Brightwave Media Ltd" for an
  // org that already pays "Brightwave Media" created a second vendor record in
  // silence.
  assert.equal(normalizeVendorName('Brightwave Media Ltd'), 'brightwavemedia');
  assert.equal(normalizeVendorName('Brightwave Media'), 'brightwavemedia');
  assert.equal(normalizeVendorName('BRIGHTWAVE MEDIA, LTD.'), 'brightwavemedia');
  // Two suffixes, because "Acme Co Ltd" carries both.
  assert.equal(normalizeVendorName('Acme Co Ltd'), 'acme');
  assert.equal(normalizeVendorName('Acme, Inc.'), 'acme');
});

test('only legal suffixes are stripped, so different companies stay different', async () => {
  const { normalizeVendorName } = await import('../src/payments/vendor-similarity.js');
  // bill-flags has a broader noise list that also drops "media", "labs" and
  // "group". Reusing it here would make these one vendor. They are not, and a
  // flag that says they are gets dismissed by reflex — the same way the old
  // confidence scores did.
  assert.notEqual(normalizeVendorName('Brightwave Media'), normalizeVendorName('Brightwave Films'));
  assert.notEqual(normalizeVendorName('Acme Labs'), normalizeVendorName('Acme Studios'));
});

test('a name that is nothing but a suffix matches nothing', async () => {
  const { normalizeVendorName, similarVendorsIn } = await import('../src/payments/vendor-similarity.js');
  // "Ltd" against "Inc" would otherwise both reduce to the empty string and be
  // declared the same company.
  assert.equal(normalizeVendorName('Ltd'), '');
  assert.equal(similarVendorsIn(
    [{ counterpartyId: 'a', displayName: 'Inc', billCount: 3, keys: [''], notSameAs: [] }],
    'Ltd', null,
  ).length, 0);
});

test('the vendor with the history is offered first', async () => {
  const { similarVendorsIn } = await import('../src/payments/vendor-similarity.js');
  const found = similarVendorsIn([
    { counterpartyId: 'stub', displayName: 'Brightwave Media Ltd', billCount: 0, keys: ['brightwavemedia'], notSameAs: [] },
    { counterpartyId: 'real', displayName: 'Brightwave Media', billCount: 4, keys: ['brightwavemedia'], notSameAs: [] },
  ], 'Brightwave Media Ltd', null);
  // If one of these is the real vendor it is almost always the one that has
  // been paid before.
  assert.deepEqual(found.map((f) => f.counterpartyId), ['real', 'stub']);
});

test('a bill never matches its own vendor', async () => {
  const { similarVendorsIn } = await import('../src/payments/vendor-similarity.js');
  const directory = [
    { counterpartyId: 'self', displayName: 'Brightwave Media', billCount: 4, keys: ['brightwavemedia'], notSameAs: [] },
  ];
  assert.equal(similarVendorsIn(directory, 'Brightwave Media', 'self').length, 0);
});

test('once somebody says they are different companies, we stop asking', async () => {
  const { similarVendorsIn } = await import('../src/payments/vendor-similarity.js');
  const directory = [
    { counterpartyId: 'self', displayName: 'Brightwave Media Ltd', billCount: 1, keys: ['brightwavemedia'], notSameAs: ['other'] },
    { counterpartyId: 'other', displayName: 'Brightwave Media', billCount: 4, keys: ['brightwavemedia'], notSameAs: ['self'] },
  ];
  // Both directions, because the next invoice can arrive under either name and
  // an answer given once should hold whichever way round it comes.
  assert.equal(similarVendorsIn(directory, 'Brightwave Media Ltd', 'self').length, 0);
  assert.equal(similarVendorsIn(directory, 'Brightwave Media', 'other').length, 0);
});

test('an alias makes the next invoice match without asking again', async () => {
  const { similarVendorsIn } = await import('../src/payments/vendor-similarity.js');
  // After "same company" is answered once, the surviving vendor carries the
  // other spelling — so a bill arriving under it lands on the right vendor
  // rather than raising the question a second time.
  const directory = [
    { counterpartyId: 'real', displayName: 'Brightwave Media', billCount: 4,
      keys: ['brightwavemedia', 'brightwavemediagroup'], notSameAs: [] },
  ];
  assert.equal(similarVendorsIn(directory, 'Brightwave Media Group', null)[0]?.counterpartyId, 'real');
});

test('the flag warns, offers both answers, and does not block', () => {
  const flags = evaluateBillFlags({
    ...baseFacts,
    vendorName: 'Brightwave Media Ltd',
    similarVendors: [{ counterpartyId: 'real', displayName: 'Brightwave Media', billCount: 4 }],
  });
  const flag = flags.find((f) => f.kind === 'similar_vendor');
  assert.ok(flag, 'the resemblance is stated');
  // A company written with and without its legal suffix is the common case;
  // stopping every one of those would be noise that gets dismissed by reflex.
  assert.equal(flag!.blocking, false);
  assert.equal(flag!.severity, 'warning');
  assert.match(flag!.message, /Brightwave Media Ltd/);
  assert.match(flag!.message, /4 bills/);
  const actions = flag!.resolutions.map((r) => r.action);
  assert.ok(actions.includes('same_vendor') && actions.includes('different_vendor'));
  // Neither answer asks for a written justification — both are determinations,
  // and the target rides along so the answer knows which vendor it is about.
  for (const r of flag!.resolutions.filter((x) => x.action !== 'ask_someone')) {
    assert.equal(r.noReason, true);
    assert.equal(r.targetId, 'real');
  }
});

test('a vendor with history is not announced as a new one', () => {
  // The rule behind this flag is written at UPLOAD, from the state of the
  // vendor's wallet at that moment. Answering "same company" on a near-match
  // then moves the bill onto a record with years of history — and the flag went
  // on saying "First bill from vendor" about a company with four bills, because
  // it was describing a vendor record the bill no longer belonged to.
  const flags = evaluateBillFlags({
    ...baseFacts,
    triggeredRules: ['unreviewed_counterparty'],
    priorBillsFromVendor: 4,
  });
  assert.equal(flags.some((f) => f.kind === 'new_vendor'), false);
});

test('a genuinely first bill still says so', () => {
  // The fix must not silence the flag entirely: on a real first bill it is the
  // context an approver wants.
  const flags = evaluateBillFlags({
    ...baseFacts,
    triggeredRules: ['unreviewed_counterparty'],
    priorBillsFromVendor: 0,
  });
  assert.equal(flags.some((f) => f.kind === 'new_vendor'), true);
});

test('the count outranks the snapshot in both directions', () => {
  // A bill whose intake raised nothing is not dressed up as a new vendor just
  // because the count is zero — the snapshot still has to have said something.
  const flags = evaluateBillFlags({ ...baseFacts, triggeredRules: [], priorBillsFromVendor: 0 });
  assert.equal(flags.some((f) => f.kind === 'new_vendor'), false);
});
