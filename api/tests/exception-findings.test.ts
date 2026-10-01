// The exception agent's findings for flags about one bill: which figure is
// off, which invoices a statement lists, what a credit note credits, whether
// the bill-to name is us. Advice only — the flag's buttons are unchanged.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { arithmeticFinding, creditNoteFinding, setAddressedCheckForTests, statementFinding } from '../src/exceptions/findings.js';
import { get, makeWorld, upload } from './helpers/companion-harness.js';

afterEach(() => setAddressedCheckForTests(null));

const line = (description: string, quantity: number, unitPrice: number, amount: number) => ({ description, quantity, unitPrice, amount });

test('figures: a document that disagrees with itself (B2) is told apart from a misread line', () => {
  // B2: three lines that each check out and add to $4,000; the total reads $4,820.
  const b2 = arithmeticFinding({
    kind: 'lines_do_not_sum', vendorName: 'Northwind Supplies', subtotal: null, tax: null, total: 4820,
    lines: [line('Warehouse shelving units', 4, 650, 2600), line('Forklift annual service', 1, 900, 900), line('Safety equipment restock', 1, 500, 500)],
  })!;
  assert.match(b2.headline, /disagrees with itself: its lines add up to \$4,000\.00, its total says \$4,820\.00/);
  assert.equal(b2.recommended?.action, 'ask_someone');
  assert.match(b2.recommended!.reason, /^On the bill from Northwind Supplies, the lines add up to \$4,000\.00, but the total says \$4,820\.00/);

  // The same bill with one line misread: quantity × price disagrees with the amount, and fixing it closes the gap.
  const misread = arithmeticFinding({
    kind: 'lines_do_not_sum', vendorName: 'Northwind Supplies', subtotal: null, tax: null, total: 4000,
    lines: [line('Warehouse shelving units', 4, 650, 2500), line('Forklift annual service', 1, 900, 900), line('Safety equipment restock', 1, 500, 500)],
  })!;
  assert.match(misread.headline, /One line was misread: "Warehouse shelving units" should be \$2,600\.00/);
  assert.equal(misread.recommended?.action, 'fix_fields');
  assert.equal(misread.points[0]!.tone, 'bad');
});

test('figures: a gap the size of one line, or of the tax, is named', () => {
  const twice = arithmeticFinding({
    kind: 'lines_do_not_sum', vendorName: 'V', subtotal: 1400, tax: null, total: 1400,
    lines: [line('Consulting', 1, 1000, 1000), line('Travel', 1, 400, 400), line('Travel', 1, 400, 400)],
  })!;
  assert.match(twice.headline, /\$400\.00 over, the exact amount of "Travel"/);
  // B3: subtotal $4,000 + $320 tax = $4,320; the total reads $4,820. The lines back the $4,320.
  const b3 = arithmeticFinding({
    kind: 'total_does_not_reconcile', vendorName: 'Kepler Legal LLP', subtotal: 4000, tax: 320, total: 4820,
    lines: [line('Contract review — vendor agreements', 8, 450, 3600), line('Regulatory filing', 1, 400, 400)],
  })!;
  assert.match(b3.headline, /\$4,000\.00 \+ \$320\.00 tax is \$4,320\.00, but it says \$4,820\.00\. The lines back the \$4,320\.00/);
  assert.equal(b3.recommended?.action, 'ask_someone');
  const taxTwice = arithmeticFinding({ kind: 'total_does_not_reconcile', vendorName: 'V', subtotal: 1000, tax: 80, total: 1160, lines: [] })!;
  assert.match(taxTwice.headline, /off by exactly the tax \(\$80\.00\): it was added twice/);
});

test('statement: says which listed invoices are here, in what state, and which are not', async () => {
  const w = await makeWorld();
  const steady = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready }, select: { counterpartyId: true } })).counterpartyId;
  const f = await statementFinding({ organizationId: w.orgId, billId: w.bills.lonely, counterpartyId: steady, vendorName: 'Steady Supply', refs: ['SS-1', 'sc-1', 'ZZ-9'] });
  assert.deepEqual(f.points.map((p) => [p.text, p.tone]), [
    ['SS-1: $300.00, in review', 'ok'],
    ['SC-1: $700.00, in approval', 'ok'],
    ['ZZ-9: not in Decimal yet', 'warn'],
  ]);
  assert.equal(f.points[0]!.billId, w.bills.steady1, 'each found invoice links to its bill');
  assert.match(f.headline, /3 invoices; 1 isn't in Decimal yet \(ZZ-9\)\. Close it and get that invoice from Steady Supply/);
  assert.deepEqual(f.recommended, { action: 'not_ours', reason: 'Statement of account from Steady Supply listing SS-1, SC-1, ZZ-9, not an invoice. Still to receive: ZZ-9.' });
});

test('credit note: finds the bill it names, or the vendor bills it could apply to', async () => {
  const w = await makeWorld();
  const steady = (await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.ready }, select: { counterpartyId: true } })).counterpartyId;
  const named = await creditNoteFinding({ organizationId: w.orgId, billId: w.bills.lonely, counterpartyId: steady, vendorName: 'Steady Supply', invoiceNumber: 'CN-7', credit: -50, texts: ['Credit — returned crates, ref SS-2'] });
  assert.match(named.headline, /CN-7 for \$50\.00 against SS-2\. Close it and take \$50\.00 off what you pay on SS-2/);
  assert.equal(named.points[1]!.billId, w.bills.ready);
  const unnamed = await creditNoteFinding({ organizationId: w.orgId, billId: w.bills.lonely, counterpartyId: steady, vendorName: 'Steady Supply', invoiceNumber: 'CN-8', credit: 50, texts: ['Credit — goodwill'] });
  assert.equal(unnamed.points.filter((p) => p.text.startsWith('Could apply to')).length, 2, 'both Steady bills are big enough');
  assert.equal(unnamed.recommended?.action, 'not_ours');
  const none = await creditNoteFinding({ organizationId: w.orgId, billId: w.bills.lonely, counterpartyId: null, vendorName: 'Nobody Ltd', invoiceNumber: 'CN-9', credit: 50, texts: [] });
  assert.match(none.points[1]!.text, /No open bill from Nobody Ltd is in Decimal/);
});

test('addressed elsewhere: checked once in the background, then a recommendation the screen shows on the flag', async () => {
  const w = await makeWorld();
  const calls: string[] = [];
  setAddressedCheckForTests(async ({ billToName }) => {
    calls.push(billToName);
    return billToName.startsWith('Halcyon Labs Incorporated') ? { verdict: 'same', reason: 'Same name with the legal suffix spelled out.' } : { verdict: 'different', reason: 'A different company.' };
  });
  const id = await upload(w.orgId, w.owner.token, 'Northgate Holdings', { vendor: 'Ironclad Security', amount: 6200, invoiceNo: 'IRN-889' });
  await drainAsyncIntake();
  const first = (await get(`/organizations/${w.orgId}/bills/${id}/draft`, w.clerk.token)).flags.find((f: { kind: string }) => f.kind === 'addressed_elsewhere');
  assert.equal(first.finding.status, 'running');
  await drainAsyncIntake();
  const flag = (await get(`/organizations/${w.orgId}/bills/${id}/draft`, w.clerk.token)).flags.find((f: { kind: string }) => f.kind === 'addressed_elsewhere');
  assert.equal(flag.finding.status, 'ready');
  assert.match(flag.finding.headline, /"Northgate Holdings" is a different company/);
  assert.equal(flag.finding.recommended.action, 'not_ours');
  await get(`/organizations/${w.orgId}/bills/${id}/draft`, w.clerk.token);
  await drainAsyncIntake();
  assert.deepEqual(calls, ['Northgate Holdings'], 'asked once, then remembered on the bill');
});

test('statement with its own rows: says what to chase and what the vendor thinks is paid that we never saw', async () => {
  const w = await makeWorld();
  const f = await statementFinding({
    organizationId: w.orgId, billId: w.bills.lonely, counterpartyId: null, vendorName: 'Meridian Logistics LLC', refs: [],
    rows: [
      { reference: 'MER-8801', amountUsd: 12400, statedStatus: 'paid', held: null },
      { reference: 'MER-8842', amountUsd: 13150, statedStatus: 'open', held: null },
      { reference: 'SS-1', amountUsd: 300, statedStatus: 'open', held: { paymentOrderId: w.bills.steady1, state: 'draft', where: 'still a draft' } },
    ],
  });
  assert.equal(f.headline, 'Close it: a statement is not a bill. One open invoice on it is not in Decimal yet (MER-8842 ($13,150.00)): get it from Meridian Logistics LLC. Meridian Logistics LLC marks MER-8801 paid, but it isn\'t in Decimal: check it was paid some other way.');
  assert.deepEqual(f.points, [], 'the statement table under it already lists the rows');
  assert.equal(f.recommended?.reason, 'Statement of account from Meridian Logistics LLC, not an invoice. Still to receive: MER-8842.');
});
