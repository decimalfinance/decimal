// The small rules of a post that a wrong answer would hide: which lines a bill goes
// up with, how a name is quoted, what a refusal says. No database and no QuickBooks.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { faultOf, plainQboReason, QboError, QuickBooks, qboLiteral } from '../src/accounting/quickbooks.js';
import { linesToPost, postBillToQuickBooks, recordedCents } from '../src/accounting/sync.js';
import { matchVendor } from '../src/accounting/vendor-match.js';

const shown = (result: ReturnType<typeof linesToPost>) => ('lines' in result ? result.lines.map((l) => [l.accountId, Number(l.cents), l.description]) : result.problem);
const line = (accountId: string, amount: number, description: string | null = null) => ({ accountId, amount, description });

test('posting lines: already at the total, nothing changes', () => {
  assert.deepEqual(shown(linesToPost([line('a', 700)], 70000n, null)), [['a', 70000, null]]);
});

test('posting lines: tax gets its own line, on the largest line\'s category', () => {
  assert.deepEqual(shown(linesToPost([line('a', 100), line('b', 900)], 108000n, 8000n)), [['a', 10000, null], ['b', 90000, null], ['b', 8000, 'Tax']]);
});

test('posting lines: tax printed on the bill but already inside the lines is not added twice', () => {
  assert.deepEqual(shown(linesToPost([line('a', 1080)], 108000n, 8000n)), [['a', 108000, null]]);
});

test('posting lines: cents lost to rounding go on the largest line', () => {
  assert.deepEqual(shown(linesToPost([line('a', 33.33), line('b', 33.34), line('c', 33.32)], 10000n, null)), [['a', 3333, null], ['b', 3335, null], ['c', 3332, null]]);
  assert.deepEqual(shown(linesToPost([line('a', 33.33), line('b', 33.33)], 7667n, 1000n)), [['a', 3334, null], ['b', 3333, null], ['a', 1000, 'Tax']]);
});

test('posting lines: any other gap is refused, in words, rather than guessed at', () => {
  assert.match(String(shown(linesToPost([line('a', 1000)], 108000n, null))), /^Its lines come to \$1,000\.00, and it was approved at \$1,080\.00, so QuickBooks would show the wrong amount\./);
  assert.match(String(shown(linesToPost([line('a', 1000)], 108000n, 5000n))), /^Its lines and tax come to \$1,050\.00, and it was approved at \$1,080\.00/);
  assert.match(String(shown(linesToPost([line('a', 1200)], 108000n, null))), /approved at \$1,080\.00/, 'more than the total as well');
});

test('posting: a bill that can\'t add up writes nothing, not even its vendor', async () => {
  const writes: string[] = [];
  const qb: any = {
    query: async () => ({ QueryResponse: {} }),
    createVendor: async () => { writes.push('vendor'); return { Vendor: { Id: 'V' } }; },
    createBill: async () => { writes.push('bill'); return { Bill: { Id: 'B' } }; },
  };
  await assert.rejects(
    postBillToQuickBooks(qb, { id: 'd', vendorLabel: 'Acme', amountUsdc: 1080, codedLines: [line('a', 1000)] }, {}),
    /would show the wrong amount/,
  );
  assert.deepEqual(writes, []);
});

test('posting: a total QuickBooks does not report is not taken for a match', () => {
  assert.equal(recordedCents({ TotalAmt: 1080.5 }), 108050n);
  assert.equal(recordedCents({}), null);
  assert.equal(recordedCents(null), null);
});

test('query quoting: apostrophes and backslashes, the way Intuit documents', () => {
  assert.equal(qboLiteral("Adam's Candy Shop"), "Adam\\'s Candy Shop");
  assert.equal(qboLiteral('A\\B'), 'A\\\\B');
  assert.equal(qboLiteral("x\\' OR 1=1"), "x\\\\\\' OR 1=1", 'a backslash cannot undo the escape after it');
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('client: a refusal on a 200 is a refusal', async () => {
  const body = { Fault: { Error: [{ code: '6210', Message: 'Account Period Closed', Detail: 'The account period has closed' }], type: 'ValidationFault' } };
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const qb = new QuickBooks({ realmId: 'r', accessToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000 });
  await assert.rejects(qb.createBill({}, 'req'), (error: unknown) => {
    assert.ok(error instanceof QboError);
    assert.equal(faultOf(error.body)?.code, '6210');
    assert.match(plainQboReason(error), /closed period/);
    return true;
  });
});

test('plain reasons: each refusal someone can act on says what to do, and the rest say what QuickBooks said', () => {
  const refusal = (code: string, status = 400) => new QboError(status, { Fault: { Error: [{ code, Message: 'Technical words', Detail: 'more of them' }] } });
  assert.match(plainQboReason(refusal('6240')), /already has this vendor's name/);
  assert.match(plainQboReason(refusal('6140')), /already has a bill with this number/);
  assert.match(plainQboReason(refusal('6200')), /closed period/);
  assert.match(plainQboReason(refusal('610')), /inactive or deleted/);
  assert.match(plainQboReason(refusal('2500')), /inactive or deleted/);
  assert.match(plainQboReason(refusal('5020', 403)), /An admin needs to sign in again/);
  assert.match(plainQboReason(refusal('3200', 401)), /stopped working/);
  assert.equal(plainQboReason(refusal('999')), 'QuickBooks said: Technical words: more of them');
  assert.match(plainQboReason(new QboError(429, {})), /slow down/);
  assert.equal(plainQboReason(new QboError(503, '<html>outage page</html>')), 'QuickBooks isn\'t answering. Decimal will try again by itself.');
  assert.match(plainQboReason(new QboError(400, 'invalid_grant')), /stopped working/);
  assert.equal(plainQboReason(new Error('Something else')), 'Something else');
});

const vendors = [
  { id: '1', name: 'Delta Freight, Inc.', active: true },
  { id: '2', name: 'Harbor Fuel', active: true },
  { id: '3', name: 'HARBOR FUEL LLC', active: true },
  { id: '4', name: 'Old Depot', active: false },
  { id: '5', name: 'Pine Mill', active: false },
  { id: '6', name: 'PINE MILL INC', active: true },
];

test('vendor match: the same name however it is spelled, and nothing looser', () => {
  assert.deepEqual(matchVendor('DELTA FREIGHT', vendors, []), { vendorId: '1' });
  assert.equal(matchVendor('Delta Freight Logistics', vendors, []), null, 'a different name is a different vendor');
  assert.equal(matchVendor('Nobody', vendors, []), null);
});

test('vendor match: a link the person made comes first', () => {
  assert.deepEqual(matchVendor('Harbor Fuel', vendors, [{ useVendorId: '3', vendorIds: ['2', '3'] }]), { vendorId: '3' });
});

test('vendor match: among live ones, the exact name; otherwise it is not guessed', () => {
  assert.deepEqual(matchVendor('Harbor Fuel', vendors, []), { vendorId: '2' });
  const unsure = matchVendor('Harbor Fuel Inc', vendors, []);
  assert.ok(unsure && 'problem' in unsure);
  assert.match(unsure.problem, /"Harbor Fuel" and "HARBOR FUEL LLC"/);
});

test('vendor match: an inactive one is passed over for the live one, and alone it is said so', () => {
  assert.deepEqual(matchVendor('Pine Mill', vendors, []), { vendorId: '6' });
  const inactive = matchVendor('Old Depot', vendors, []);
  assert.ok(inactive && 'problem' in inactive);
  assert.match(inactive.problem, /"Old Depot" is inactive in QuickBooks/);
});
