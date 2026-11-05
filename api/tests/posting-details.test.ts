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

/** A client whose access token has run out. Each test spends its own refresh token: renewals are shared by it. */
const expired = (refreshToken: string) => ({ realmId: 'r', accessToken: 'old', refreshToken, expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 86_400_000 });
const isRenewal = (input: string | URL | Request) => String(input instanceof Request ? input.url : input).includes('/oauth2/v1/tokens/bearer');

test('client: two requests at once on a run-out token renew it once, and both go through', async () => {
  let renewed = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!isRenewal(input)) return new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 });
    renewed += 1;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'race-2', expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }), { status: 200 });
  }) as typeof fetch;
  const saved: string[] = [];
  const client = () => new QuickBooks(expired('race-1'), (t) => { saved.push(t.refreshToken); });
  await Promise.all([client().query('SELECT 1'), client().query('SELECT 1')]);
  assert.equal(renewed, 1);
  assert.deepEqual(saved, ['race-2', 'race-2']);
});

test('client: a refresh token another process already spent is not taken for a lost sign-in', async () => {
  const used: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (isRenewal(input)) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    used.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 });
  }) as typeof fetch;
  let signedOut = 0;
  const elsewhere = { ...expired('spent-2'), accessToken: 'stored', expiresAt: Date.now() + 3_600_000 };
  await new QuickBooks(expired('spent-1'), undefined, () => { signedOut += 1; }, async () => elsewhere).query('SELECT 1');
  assert.deepEqual([signedOut, used], [0, ['Bearer stored']], 'the stored token is used');

  const lost = new QuickBooks(expired('lost-1'), undefined, () => { signedOut += 1; }, async () => expired('lost-1'));
  await assert.rejects(lost.query('SELECT 1'), (error: unknown) => error instanceof QboError && error.isAuthInvalid);
  assert.equal(signedOut, 1, 'with nothing newer stored, it is a lost sign-in');
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

// What a real sandbox showed (5 Nov 2026): QuickBooks renames a vendor it makes
// inactive, "(deleted)" and then "(deleted-1)" and on, so the name looks free.
test('vendor match: one QuickBooks renamed "(deleted)" when it made it inactive is still that vendor', () => {
  const books = [
    { id: '41', name: 'Hicks Hardware (deleted)', active: false },
    { id: '76', name: 'Cedar & Pine Office Supply (deleted)', active: false },
    { id: '126', name: 'Cedar & Pine Office Supply (deleted-1)', active: false },
    { id: '200', name: 'Cedar and Pine Office Supply', active: true },
  ];
  const gone = matchVendor('Hicks Hardware', books, []);
  assert.ok(gone && 'problem' in gone);
  assert.equal(gone.problem, '"Hicks Hardware" is inactive in QuickBooks, where it shows as "Hicks Hardware (deleted)". Make it active there, then retry.');
  assert.deepEqual(matchVendor('Cedar & Pine Office Supply', books, []), { vendorId: '200' }, 'the live one of that name');
  assert.equal(matchVendor('Hicks Hardware', [{ id: '9', name: 'Hicks Hardware (deleted)', active: true }], []), null, 'only an inactive one is read that way');
});

/**
 * QuickBooks' rules for a vendor's name, as a sandbox showed them: one name per
 * record across vendors, customers and employees, whatever the case, and an
 * inactive vendor renamed. Only the calls a post makes.
 */
function namedBooks(start: { vendors?: Array<{ Id: string; DisplayName: string; Active: boolean }>; customers?: string[]; employees?: string[] }) {
  const vendors = [...(start.vendors ?? [])];
  const people = { Customer: start.customers ?? [], Employee: start.employees ?? [] };
  const made: string[] = [];
  const bills: any[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const nameIn = (q: string) => (q.match(/DisplayName (?:=|LIKE) '((?:[^'\\]|\\.)*)'/)?.[1] ?? '').replace(/\\(.)/g, '$1');
  const qb: any = {
    query: async (q: string) => {
      const name = nameIn(q);
      const entity = (['Customer', 'Employee'] as const).find((e) => q.includes(`FROM ${e} `));
      if (entity) return { QueryResponse: { [entity]: people[entity].filter((n) => same(n, name)).map((n) => ({ Id: n })) } };
      if (q.includes(' LIKE ')) {
        const start = name.replace(/%$/, '').toLowerCase();
        return { QueryResponse: { Vendor: vendors.filter((v) => !v.Active && v.DisplayName.toLowerCase().startsWith(start)) } };
      }
      return { QueryResponse: { Vendor: vendors.filter((v) => same(v.DisplayName, name)) } };
    },
    createVendor: async ({ DisplayName }: { DisplayName: string }) => {
      if ([...vendors.map((v) => v.DisplayName), ...people.Customer, ...people.Employee].some((n) => same(n, DisplayName))) {
        throw new QboError(400, { Fault: { Error: [{ code: '6240', Message: 'Duplicate Name Exists Error', Detail: 'The name supplied already exists.' }] } });
      }
      const vendor = { Id: `V${vendors.length + 1}`, DisplayName, Active: true };
      vendors.push(vendor);
      made.push(DisplayName);
      return { Vendor: vendor };
    },
    createBill: async (body: any) => { bills.push(body); return { Bill: { Id: `B${bills.length}` } }; },
    readEntity: async (_entity: string, id: string) => {
      const sent = bills[Number(id.slice(1)) - 1];
      return { Bill: { TotalAmt: sent.Line.reduce((n: number, l: { Amount: number }) => n + l.Amount, 0), Balance: 0 } };
    },
  };
  return { qb, made, bills };
}

const billFrom = (vendorLabel: string, id = 'd1') => ({ id, vendorLabel, amountUsdc: 45, codedLines: [line('a', 45)] });

test('posting: a vendor QuickBooks made inactive is refused by its name, not made a second time', async () => {
  const { qb, made, bills } = namedBooks({ vendors: [{ Id: '41', DisplayName: 'Hicks Hardware (deleted)', Active: false }] });
  await assert.rejects(postBillToQuickBooks(qb, billFrom('Hicks Hardware'), {}), {
    message: '"Hicks Hardware" is inactive in QuickBooks, where it shows as "Hicks Hardware (deleted)". Make it active there, then retry.',
  });
  assert.deepEqual([made, bills], [[], []]);
});

test('posting: a business that is also a customer, or someone on the payroll, is posted to "Name (vendor)", made once', async () => {
  const { qb, made, bills } = namedBooks({ customers: ["Amy's Bird Sanctuary"], employees: ['Emily Platt'] });
  await postBillToQuickBooks(qb, billFrom("Amy's Bird Sanctuary", 'd1'), {});
  await postBillToQuickBooks(qb, billFrom("AMY'S BIRD SANCTUARY", 'd2'), {});
  await postBillToQuickBooks(qb, billFrom('Emily Platt', 'd3'), {});
  assert.deepEqual(made, ["Amy's Bird Sanctuary (vendor)", 'Emily Platt (vendor)']);
  assert.deepEqual(bills.map((b) => b.VendorRef.value), ['V1', 'V1', 'V2'], 'the second bill finds the first one\'s vendor');
});

test('posting: a name QuickBooks calls taken, when no customer or employee has it, is refused as QuickBooks said', async () => {
  const { qb, made } = namedBooks({});
  qb.createVendor = async () => { throw new QboError(400, { Fault: { Error: [{ code: '6240', Message: 'Duplicate Name Exists Error' }] } }); };
  await assert.rejects(postBillToQuickBooks(qb, billFrom('Ghost Supply'), {}), (error: unknown) => error instanceof QboError);
  assert.deepEqual(made, []);
});
