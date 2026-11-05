// Is a bill already in the books it would post to? Someone may have keyed it into
// QuickBooks by hand, and QuickBooks takes the same bill twice without a word. Code
// decides what could be the same bill, a person says whether it is, and until
// someone does only the posting waits: review and approval go on as usual.
//
// QuickBooks is a fake holding the bills already there, and recording what Decimal
// sends, so these assert exactly what would reach the books.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { drainBackgroundWork } from '../src/infra/background.js';
import { setQuickBooksForTests } from '../src/accounting/connections.js';
import { QboError } from '../src/accounting/quickbooks.js';
import { sweepUnsyncedSettledOrders } from '../src/accounting/account-sync.js';
import { fingerprintOf, heldMessage, matchesInBooks, numberVariants, sameNumber, type BillForBooks, type BooksMatch } from '../src/accounting/books-check.js';
import { evaluateBillFlags } from '../src/payments/bill-flags.js';
import type { BooksBill } from '../src/integrations/books.js';
import { get, makeWorld, post, raw } from './helpers/companion-harness.js';

beforeEach(() => setQuickBooksForTests(null));

// ─── What counts as the same bill ────────────────────────────────────────────

const bill = (over: Partial<BillForBooks> = {}): BillForBooks => ({
  vendorName: 'Hall Properties', vendorIds: ['56'], number: 'INV-01042', totalMinor: 125_000n, currency: 'USD', date: '2026-08-10', ...over,
});

const there = (over: Partial<BooksBill> = {}): BooksBill => ({
  id: '900', number: null, vendorId: '56', vendorName: 'Hall Properties', date: '2026-08-10', dueDate: null, currency: 'USD',
  totalMinor: 125_000n, balanceMinor: 125_000n, taxMinor: null, payableAccountId: null, termsId: null, locationId: null, locationName: null,
  note: null, lines: [], createdAt: '2026-08-11T15:00:00Z', updatedAt: null, ...over,
});

const none = new Set<string>();

test('books check: one number written two ways is one number, and two numbers are two bills', () => {
  assert.equal(sameNumber('INV-01042', 'inv 01042'), true);
  assert.equal(sameNumber('INV-01042', '1042'), true, 'keyed in by hand as its digits');
  assert.equal(sameNumber('SC-1', 'SC1'), true);
  assert.equal(sameNumber('SC-1', 'SC-2'), false);
  assert.equal(sameNumber('A-12', '12'), false, 'two digits are too few to go on alone');
  assert.equal(sameNumber('', ''), false);
  assert.deepEqual(numberVariants('INV-01042'), ['INV-01042', 'INV 01042', 'INV01042', '01042', '1042'], 'asked for as written and as likely keyed');
  assert.deepEqual(numberVariants('inv 01042'), ['inv 01042', 'inv-01042', 'INV01042', '01042', '1042'], 'its case is QuickBooks’ business');
  assert.deepEqual(numberVariants('SC-1'), ['SC-1', 'SC 1', 'SC1']);
  assert.deepEqual(numberVariants('  '), []);
  assert.deepEqual(numberVariants(null), []);
});

test('books check: the same number from the same vendor is a match, however the vendor is filed there', () => {
  assert.deepEqual(matchesInBooks(bill(), [there({ id: '1', number: '1042' })], none).map((m) => [m.recordId, m.why]), [['1', 'number']]);
  assert.deepEqual(
    matchesInBooks(bill({ vendorIds: [] }), [there({ id: '2', number: 'INV-01042', vendorId: '99', vendorName: 'Hall Properties LLC' })], none).map((m) => m.recordId),
    ['2'], 'the same name under another record',
  );
  assert.deepEqual(matchesInBooks(bill(), [there({ id: '3', number: 'INV-01042', vendorId: '77', vendorName: 'Norton Stone' })], none), [], 'another vendor’s number is theirs');
  assert.deepEqual(matchesInBooks(bill(), [there({ id: '4', number: 'INV-01043' })], none), [], 'two numbers that differ are two bills, however alike the rest');
});

test('books check: with no number on one side, the same vendor, amount and currency within a week is enough to ask', () => {
  const found = matchesInBooks(bill(), [
    there({ id: '5', date: '2026-08-15' }),
    there({ id: '6', date: '2026-08-18' }),
    there({ id: '7', totalMinor: 125_001n }),
    there({ id: '8', currency: 'CAD' }),
    there({ id: '9', vendorId: '99' }),
  ], none);
  assert.deepEqual(found.map((m) => [m.recordId, m.why]), [['5', 'amount_and_date']], 'five days apart; not eight, another amount, another currency, or only a like name');
  assert.deepEqual(matchesInBooks(bill({ number: null }), [there({ id: '10', number: 'X-1' })], none).map((m) => m.recordId), ['10'], 'no number on this side');
});

test('books check: what Decimal posted itself is never "already there"', () => {
  assert.deepEqual(matchesInBooks(bill(), [there({ id: '11', number: 'INV-01042' })], new Set(['11'])), [], 'posted for another bill');
  assert.deepEqual(matchesInBooks(bill(), [there({ id: '12', number: 'INV-01042', note: `Decimal decimal_${crypto.randomUUID()} | PO 7` })], none), [], 'its note names a Decimal bill');
});

test('books check: numbers before amounts, closest first, three at most', () => {
  const found = matchesInBooks(bill(), [
    there({ id: 'a', date: '2026-08-11' }),
    there({ id: 'b', number: '1042', date: '2026-07-01' }),
    there({ id: 'c', number: 'INV1042', date: '2026-08-09' }),
    there({ id: 'd', date: '2026-08-10' }),
  ], none);
  assert.deepEqual(found.map((m) => m.recordId), ['c', 'b', 'd']);
});

test('books check: the fingerprint is what was looked for, in which books', () => {
  const scope = { system: 'quickbooks', companyId: 'realm-test' };
  assert.equal(fingerprintOf(scope, bill({ vendorIds: ['56', '57'] })), fingerprintOf(scope, bill({ vendorIds: ['57', '56'] })));
  assert.notEqual(fingerprintOf(scope, bill()), fingerprintOf(scope, bill({ number: 'INV-01043' })));
  assert.notEqual(fingerprintOf(scope, bill()), fingerprintOf({ ...scope, companyId: 'other' }, bill()));
});

test('books check: the held message names the bill there, and how many more there are', () => {
  const found = matchesInBooks(bill(), [there({ id: '1', number: 'INV-01042', balanceMinor: 0n }), there({ id: '2' })], none);
  assert.equal(heldMessage('quickbooks', found),
    'QuickBooks already has bill INV-01042 from Hall Properties for $1,250.00, dated 10 Aug 2026, already paid, entered there outside Decimal. '
    + 'It has 1 more that could be this one. Say on the bill whether it\'s the same one: if it is, Decimal links to it instead of posting it twice.');
});

// ─── What the bill says about it ─────────────────────────────────────────────

const baseFacts = {
  vendorName: 'Hall Properties',
  organizationName: 'Decimal Labs',
  tradingNames: [] as string[],
  amountRaw: 1_250_000_000n,
  billToName: null,
  triggeredRules: [] as string[],
  vendorHold: null,
  ceilingMinor: null,
  duplicates: [],
  similarVendors: [],
  priorBillsFromVendor: 3,
  duplicateClearances: [],
  ceilingException: null,
  shortPay: null,
  amounts: { lineItemsTotal: null, subtotal: null, tax: null, total: null },
  planAlerts: [] as string[],
  documentType: { invoiceNumber: null as string | null, lineInvoiceRefs: [] as string[] },
};

const [first, second] = matchesInBooks(bill(), [there({ id: '1', number: 'INV-01042' }), there({ id: '2' })], none) as [BooksMatch, BooksMatch];
const inBooksFlag = (answers: Array<{ recordId: string; same: boolean }>, matches = [first, second]) =>
  evaluateBillFlags({ ...baseFacts, inBooks: { system: 'quickbooks', status: 'ready', matches, answers: answers.map((a) => ({ ...a, byName: 'Zara Okafor', at: '2026-08-12T10:00:00Z' })) } })
    .find((f) => f.kind === 'in_books');

test('books check flag: unanswered, it warns without blocking, and offers the two answers about the closest one', () => {
  const flag = inBooksFlag([])!;
  assert.equal(flag.severity, 'warning');
  assert.equal(flag.blocking, false, 'review and approval go on; only the posting waits');
  assert.equal(flag.short, 'Already in QuickBooks?');
  assert.match(flag.message, /^QuickBooks already has bill INV-01042 from Hall Properties for \$1,250\.00, dated 10 Aug 2026, entered there outside Decimal\. It has 1 more/);
  assert.deepEqual(flag.resolutions.filter((r) => r.targetId).map((r) => [r.action, r.targetId, r.requires, r.noReason]), [
    ['same_bill', '1', 'anyone', true],
    ['different_bill', '1', 'anyone', true],
  ]);
});

test('books check flag: each answer moves it on, and "same" settles it', () => {
  assert.deepEqual(inBooksFlag([{ recordId: '1', same: false }])!.resolutions.filter((r) => r.targetId).map((r) => r.targetId), ['2', '2'], 'then the next one');
  const checked = inBooksFlag([{ recordId: '1', same: false }, { recordId: '2', same: false }])!;
  assert.equal(checked.severity, 'info');
  assert.equal(checked.short, 'Checked in QuickBooks');
  const linked = inBooksFlag([{ recordId: '2', same: true }])!;
  assert.equal(linked.severity, 'info');
  assert.equal(linked.short, 'Linked in QuickBooks');
  assert.match(linked.message, /^Zara Okafor said this is the bill already in QuickBooks: a bill from Hall Properties for the same \$1,250\.00/);
});

test('books check flag: a "same" about a bill no longer there counts for nothing', () => {
  const flag = inBooksFlag([{ recordId: 'gone', same: true }], [first])!;
  assert.equal(flag.severity, 'warning', 'asked again about what is there now');
  assert.equal(inBooksFlag([{ recordId: 'gone', same: true }], []), undefined, 'and with nothing there, nothing to say');
});

// ─── Approved: posted, held, linked ──────────────────────────────────────────

type Row = Record<string, unknown>;
const CHART = [{ Id: '301', Name: 'Cloud hosting & infrastructure' }, { Id: '302', Name: 'Travel' }];
const notFound = () => new QboError(400, { Fault: { Error: [{ code: '610', Message: 'Object Not Found' }], type: 'ValidationFault' } });

/** Submit Co's SC-1, keyed into QuickBooks by hand before Decimal could post it. */
const HAND: Row = {
  Id: '77', DocNumber: 'SC-1', VendorRef: { value: '9', name: 'Submit Co' }, TxnDate: '2026-08-01', TotalAmt: 700, Balance: 700,
  MetaData: { CreateTime: '2026-08-03T10:00:00-07:00' },
};

/** QuickBooks with bills already in it. Records what Decimal asks for and sends. */
function books(already: Row[] = []) {
  const state = { already, failRead: null as Error | null };
  const asked: string[] = [];
  const created: Array<{ body: any; requestId: string }> = [];
  const qb: any = {
    realmId: 'realm-test',
    query: async (q: string) => {
      asked.push(q);
      if (q.includes('FROM Account')) return { QueryResponse: { Account: CHART.map((a) => ({ FullyQualifiedName: a.Name, Classification: 'Expense', AccountType: 'Expense', ...a })) } };
      if (q.includes('FROM Preferences')) return { QueryResponse: { Preferences: [{ AccountingInfoPrefs: {}, CurrencyPrefs: { HomeCurrency: { value: 'USD' } } }] } };
      if (q.includes('FROM Bill')) {
        if (state.failRead) throw state.failRead;
        return { QueryResponse: state.already.length ? { Bill: state.already } : {} };
      }
      return { QueryResponse: { Vendor: [{ Id: 'V1' }] } };
    },
    createVendor: async () => ({ Vendor: { Id: 'V1' } }),
    createBill: async (body: any, requestId: string) => {
      created.push({ body, requestId });
      return { Bill: { Id: `B${created.length}` } };
    },
    readEntity: async (_entity: string, id: string) => {
      const hand = state.already.find((b) => b.Id === id);
      if (hand) return { Bill: { Balance: hand.Balance, TotalAmt: hand.TotalAmt } };
      const sent = created[Number(id.slice(1)) - 1]?.body;
      if (!sent) throw notFound();
      const total = sent.Line.reduce((n: number, l: { Amount: number }) => n + l.Amount, 0);
      return { Bill: { Balance: total, TotalAmt: total } };
    },
  };
  setQuickBooksForTests(() => qb);
  return { state, asked, created };
}

/** Connected, with posting on since a minute ago. */
async function connect(orgId: string) {
  const far = new Date(Date.now() + 86_400_000);
  await prisma.accountingConnection.create({ data: {
    organizationId: orgId, realmId: 'realm-test', accessToken: 'x', refreshToken: 'y', accessTokenExpiresAt: far, refreshTokenExpiresAt: far,
    postingEnabledAt: new Date(Date.now() - 60_000),
  } });
  await prisma.accountingAccountMap.create({ data: { organizationId: orgId, clearingAccountId: '901', clearingAccountName: 'USDC clearing' } });
}

/** Approve Submit Co's bill as the approver it waits on; the posting runs in the background. */
async function approve(w: Awaited<ReturnType<typeof makeWorld>>) {
  const inbox = await get(`/organizations/${w.orgId}/bills/approvals-inbox`, w.apprA.token);
  const mine = (inbox.waitingOnYou as Array<{ paymentOrderId: string; taskId: string }>).find((x) => x.paymentOrderId === w.bills.submitted)!;
  await post(`/organizations/${w.orgId}/approvals/tasks/${mine.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, w.apprA.token);
  await drainAsyncIntake();
}

const syncOf = (billId: string) => prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'quickbooks' } } });
const answer = (w: Awaited<ReturnType<typeof makeWorld>>, recordId: string, same: boolean, token = w.owner.token) =>
  raw('POST', `/organizations/${w.orgId}/bills/${w.bills.submitted}/in-books`, token, { recordId, same });
const retry = (w: Awaited<ReturnType<typeof makeWorld>>) => post(`/organizations/${w.orgId}/payment-orders/${w.bills.submitted}/accounting/sync`, {}, w.owner.token);
const inBooksOf = (detail: any) => detail.draft.flags.find((f: { kind: string }) => f.kind === 'in_books');

test('books check: a bill keyed into QuickBooks by hand holds its posting, and "different bill" posts it', async () => {
  const w = await makeWorld();
  const qb = books([HAND]);
  await connect(w.orgId);
  await approve(w);

  const held = await syncOf(w.bills.submitted);
  assert.equal(held?.status, 'held');
  assert.equal(qb.created.length, 0, 'nothing posted');
  assert.match(held?.error ?? '', /^QuickBooks already has bill SC-1 from Submit Co for \$700\.00, dated 1 Aug 2026, entered there outside Decimal\./);
  assert.ok(qb.asked.some((q) => q.startsWith(`SELECT * FROM Bill WHERE DocNumber IN ('SC-1', 'SC 1', 'SC1')`)), 'asked for by its number');

  await sweepUnsyncedSettledOrders();
  assert.equal((await retry(w)).outcome, 'held', 'a retry looks again, and it is still there');
  assert.equal(qb.created.length, 0, 'neither the sweep nor a retry posts it');

  const detail = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  assert.equal(detail.posting.status, 'held');
  assert.equal(inBooksOf(detail).severity, 'warning');

  const box = await get(`/organizations/${w.orgId}/inbox`, w.owner.token);
  const line = box.items.find((i: { billId: string }) => i.billId === w.bills.submitted)?.lines.find((l: { kind: string }) => l.kind === 'sync_held');
  assert.equal(line?.text, 'QuickBooks already has bill SC-1 from Submit Co for $700.00, dated 1 Aug 2026, entered there outside Decimal. Is it the same bill?');
  assert.equal(JSON.stringify(await get(`/organizations/${w.orgId}/inbox`, w.apprA.token)).includes('sync_held'), false, 'an approver can’t answer it, so isn’t asked');

  assert.equal((await answer(w, '77', false, w.apprA.token)).status, 403, 'answered by someone who checks bills');
  const said = await answer(w, '77', false);
  assert.equal(said.status, 200);
  assert.equal(said.json.posting, 'synced');
  assert.equal(said.json.linked, false);
  assert.deepEqual(qb.created.map((b) => b.body.DocNumber), ['SC-1'], 'posted as its own bill');
  const synced = await syncOf(w.bills.submitted);
  assert.equal(synced?.status, 'synced');
  assert.equal(synced?.externalBillId, 'B1');
  const event = await prisma.paymentOrderEvent.findFirst({ where: { paymentOrderId: w.bills.submitted, eventType: 'policy_overridden' }, orderBy: { createdAt: 'desc' } });
  assert.match(String((event?.payloadJson as Row | null)?.reason), /said the bill in QuickBooks, bill SC-1 from Submit Co for \$700\.00, dated 1 Aug 2026, is a different one/);
  assert.equal(JSON.stringify(await get(`/organizations/${w.orgId}/inbox`, w.owner.token)).includes('sync_held'), false, 'the Inbox line clears itself');
});

test('books check: "same bill" links to the one already there instead of posting it, and nothing more can be said after', async () => {
  const w = await makeWorld();
  const qb = books([HAND]);
  await connect(w.orgId);
  await approve(w);
  assert.equal((await syncOf(w.bills.submitted))?.status, 'held');

  const said = await answer(w, '77', true);
  assert.equal(said.json.posting, 'synced');
  assert.equal(said.json.linked, true);
  assert.equal(qb.created.length, 0, 'never posted a second time');
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'synced');
  assert.equal(sync?.externalBillId, '77', 'linked to the bill keyed in by hand');
  assert.equal(sync?.externalVendorId, '9');
  assert.equal((sync?.metadataJson as Row | null)?.linkedFromBooks, true);

  const detail = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  assert.equal(detail.posting.status, 'posted');
  assert.equal(detail.posting.linked, true);
  assert.equal(inBooksOf(detail).short, 'Linked in QuickBooks');
  assert.equal((await answer(w, '77', false)).status, 409, 'in QuickBooks already: there is nothing left to decide');
});

test('books check: answered in review, the bill links or posts at approval without being held', async () => {
  const w = await makeWorld();
  const qb = books([HAND]);
  await connect(w.orgId);

  // Opening the bill looks in the books, in the background.
  const first = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  assert.equal(first.draft.booksCheck?.status, 'running');
  await drainBackgroundWork();
  const opened = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  assert.equal(opened.draft.booksCheck?.status, 'ready');
  assert.equal(inBooksOf(opened)?.short, 'Already in QuickBooks?');
  assert.equal(qb.asked.filter((q) => q.includes('FROM Bill')).length, 1, 'looked once, not again on the second read');

  const said = await answer(w, '77', true);
  assert.equal(said.json.posting, null, 'not approved yet: nothing to post or link');
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'synced');
  assert.equal(sync?.externalBillId, '77');
  assert.equal(qb.created.length, 0);
});

test('books check: a "same" about a bill since deleted there posts this one instead of linking to nothing', async () => {
  const w = await makeWorld();
  const qb = books([HAND]);
  await connect(w.orgId);
  await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  await drainBackgroundWork();
  assert.equal((await answer(w, '77', true)).status, 200);

  qb.state.already = [];
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'synced');
  assert.equal(sync?.externalBillId, 'B1', 'posted as its own');
  assert.equal((sync?.metadataJson as Row | null)?.linkedFromBooks, undefined);
});

test('books check: linked to a bill someone then deletes in QuickBooks, it is unlinked and the next try posts it', async () => {
  const w = await makeWorld();
  const qb = books([{ ...HAND, TotalAmt: 650, Balance: 650 }]);
  await connect(w.orgId);
  await approve(w);
  const said = await answer(w, '77', true);
  assert.equal(said.json.posting, 'error');
  assert.equal(said.json.linked, true);
  const wrong = await syncOf(w.bills.submitted);
  assert.match(wrong?.error ?? '', /QuickBooks recorded this bill at \$650\.00, and it was approved at \$700\.00/, 'linked, and its total checked like any posted bill');

  qb.state.already = [];
  assert.equal((await retry(w)).outcome, 'error');
  const unlinked = await syncOf(w.bills.submitted);
  assert.equal(unlinked?.externalBillId, null);
  assert.match(unlinked?.error ?? '', /has been deleted there, so it isn't linked any more/);

  assert.equal((await retry(w)).outcome, 'synced');
  assert.deepEqual(qb.created.map((b) => b.body.DocNumber), ['SC-1'], 'nothing there now, so it posts');
});

test('books check: when the books can\'t be read, nothing posts blind', async () => {
  const w = await makeWorld();
  const qb = books([HAND]);
  qb.state.failRead = new QboError(400, { Fault: { Error: [{ code: '4000', Message: 'Error parsing query' }], type: 'ValidationFault' } });
  await connect(w.orgId);
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.equal(qb.created.length, 0);

  qb.state.failRead = null;
  assert.equal((await retry(w)).outcome, 'held', 'read again, it asks');
});
