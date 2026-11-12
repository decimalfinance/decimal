// Xero, as the books a team posts to: a bill is posted when it is APPROVED, as a
// bill awaiting payment, with a line per confirmed Category, its contact found by
// name or made, and the invoice on it. The same checks as QuickBooks come first:
// already in Xero, a closed period, an archived contact.
//
// Xero is in memory: its API answers from an organisation in Xero's own JSON, as
// the bench's made-up one does, and takes the writes posting makes. Every request
// that leaves Decimal is kept. A write sent again with its Idempotency-Key gets the
// first answer back, whatever it was, as the strictest Xero would.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, test } from 'node:test';
import { config } from '../src/config.js';
import { prisma } from '../src/infra/prisma.js';
import { drainAsyncIntake } from '../src/payments/invoice-intake.js';
import { categoryNamesFor } from '../src/payments/bills.js';
import { listChartOfAccounts } from '../src/accounting/ocr-coding.js';
import { syncApprovedBill, sweepUnsyncedSettledOrders } from '../src/accounting/account-sync.js';
import { answerBooksMatch } from '../src/accounting/books-check.js';
import { postingTarget } from '../src/accounting/connections.js';
import { doneConditions } from '../src/integrations/setup/gates.js';
import { drainBackgroundWork } from '../src/infra/background.js';
import { fixtureXeroClient, xeroDate, type XeroFixture } from '../src/integrations/xero-fixture.js';
import { XeroApiError } from '../src/integrations/xero-reader.js';
import { baseUrl, post, get, makeWorld } from './helpers/companion-harness.js';

const TENANT = '3b0f6c1e-5d2a-4e8b-9c47-a1d2e3f4b5c6';

type Row = Record<string, any>;

function organisation(over: Partial<XeroFixture> = {}, org: Row = {}): XeroFixture {
  return {
    Organisation: {
      OrganisationID: TENANT, Name: 'Larkspur Freight', BaseCurrency: 'USD', CountryCode: 'US', OrganisationStatus: 'ACTIVE',
      Class: 'PREMIUM', FinancialYearEndMonth: 12, FinancialYearEndDay: 31, ...org,
    },
    Currencies: [{ Code: 'USD' }],
    TrackingCategories: [],
    Accounts: [
      { AccountID: 'acc-cloud', Code: '485', Name: 'Cloud hosting & infrastructure', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' },
      { AccountID: 'acc-travel', Code: '493', Name: 'Travel', Type: 'OVERHEADS', Class: 'EXPENSE', Status: 'ACTIVE' },
      { AccountID: 'acc-bank', Code: '090', Name: 'Business Bank Account', Type: 'BANK', Class: 'ASSET', Status: 'ACTIVE', BankAccountType: 'BANK' },
      { AccountID: 'acc-ap', Code: '800', Name: 'Accounts Payable', Type: 'CURRLIAB', Class: 'LIABILITY', Status: 'ACTIVE', SystemAccount: 'CREDITORS' },
      { AccountID: 'acc-old', Code: '499', Name: 'Old expenses', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ARCHIVED' },
    ],
    Contacts: [],
    Invoices: [],
    BankTransactions: [],
    LinkedTransactions: [],
    ...over,
  };
}

type Sent = { method: string; path: string; key: string | null; contentType: string | null; body: unknown };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Xero, in memory, for the length of a test. */
function xero(fixture: XeroFixture) {
  const realFetch = globalThis.fetch;
  const saved = { id: config.xeroClientId, secret: config.xeroClientSecret, file: config.xeroFixtureFile };
  config.xeroClientId = 'test-client';
  config.xeroClientSecret = 'test-secret';
  config.xeroFixtureFile = '';
  const reads = fixtureXeroClient(fixture);
  const sent: Sent[] = [];
  const answered = new Map<string, { status: number; body: unknown }>();
  const files: Array<{ billId: string; fileName: string; contentType: string | null; bytes: Buffer }> = [];
  const state = {
    /** The next bill lands, and its answer never reaches Decimal. */
    loseAnswer: false,
    /** The next bill is refused, in these words. */
    refuse: null as string | null,
    /** What Xero records a bill at, when that isn't what was sent. */
    recordedTotal: null as number | null,
  };
  let made = 0;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const refusal = (message: string) => ({
    status: 400,
    body: { ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: message }] }] },
  });

  function write(path: string, body: unknown, contentType: string | null): { status: number; body: unknown } {
    if (path === 'Contacts') {
      const name = String((JSON.parse(String(body)) as Row).Contacts[0].Name);
      if (fixture.Contacts.some((c) => String(c.Name).toLowerCase() === name.toLowerCase())) {
        return refusal(`The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`);
      }
      const contact = { ContactID: `contact-${++made}`, Name: name, ContactStatus: 'ACTIVE', IsSupplier: true, IsCustomer: false };
      fixture.Contacts.push(contact);
      return { status: 200, body: { Contacts: [contact] } };
    }
    if (path === 'Invoices') {
      if (state.refuse) {
        const words = state.refuse;
        state.refuse = null;
        return refusal(words);
      }
      const bill = (JSON.parse(String(body)) as Row).Invoices[0] as Row;
      const contact = fixture.Contacts.find((c) => c.ContactID === bill.Contact?.ContactID);
      if (!contact) return refusal('The contact could not be found.');
      for (const line of bill.LineItems as Row[]) {
        const account = fixture.Accounts.find((a) => (line.AccountCode ? a.Code === line.AccountCode : a.AccountID === line.AccountID));
        if (!account || account.Status !== 'ACTIVE' || account.Type === 'BANK' || account.SystemAccount) return refusal(`Account code '${line.AccountCode}' is not a valid code for this document.`);
      }
      const cents = (bill.LineItems as Row[]).reduce((n, l) => n + Math.round(Number(l.Quantity) * Number(l.UnitAmount) * 100), 0);
      const total = state.recordedTotal ?? cents / 100;
      const row = {
        InvoiceID: `bill-${++made}`, Type: bill.Type, Status: bill.Status, InvoiceNumber: bill.InvoiceNumber,
        Contact: { ContactID: contact.ContactID, Name: contact.Name },
        Date: bill.Date ? xeroDate(bill.Date) : undefined, DueDate: bill.DueDate ? xeroDate(bill.DueDate) : undefined,
        LineAmountTypes: bill.LineAmountTypes, CurrencyCode: bill.CurrencyCode,
        LineItems: (bill.LineItems as Row[]).map((l, i) => ({ LineItemID: `line-${made}-${i}`, ...l, LineAmount: Number(l.Quantity) * Number(l.UnitAmount), TaxAmount: 0 })),
        SubTotal: total, TotalTax: 0, Total: total, AmountDue: total, UpdatedDateUTC: xeroDate(new Date().toISOString().slice(0, 10)),
      };
      fixture.Invoices.push(row);
      return { status: 200, body: { Invoices: [row] } };
    }
    const attachment = /^Invoices\/([^/]+)\/Attachments\/(.+)$/.exec(path);
    if (attachment) {
      const fileName = decodeURIComponent(attachment[2]!);
      files.push({ billId: decodeURIComponent(attachment[1]!), fileName, contentType, bytes: Buffer.from(body as Uint8Array) });
      return { status: 200, body: { Attachments: [{ AttachmentID: `file-${++made}`, FileName: fileName }] } };
    }
    return { status: 404, body: { Message: `No ${path}` } };
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    if (!url.startsWith('https://api.xero.com/api.xro/2.0/')) return new Response('not Xero', { status: 599 });
    const at = new URL(url);
    const path = decodeURI(at.pathname.slice('/api.xro/2.0/'.length));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    sent.push({ method, path, key: headers.get('idempotency-key'), contentType: headers.get('content-type'), body: init?.body });
    if (headers.get('xero-tenant-id') !== TENANT) return reply({ Title: 'Forbidden', Detail: 'AuthenticationUnsuccessful' }, 403);
    if (method === 'GET') {
      const one = /^Invoices\/([^/]+)$/.exec(path);
      if (one) {
        const bill = fixture.Invoices.find((i) => i.InvoiceID === one[1]);
        return bill ? reply({ Invoices: [bill] }) : reply({ Message: 'Not found' }, 404);
      }
      try {
        return reply(await reads.get(path, Object.fromEntries(at.searchParams)));
      } catch (error) {
        return reply({ Message: String(error) }, error instanceof XeroApiError ? error.status : 500);
      }
    }
    const key = headers.get('idempotency-key');
    if (!key) return reply({ Message: 'Every write here carries a key.' }, 400);
    const first = answered.get(key);
    if (first) return reply(first.body, first.status);
    const answer = write(path, init?.body, headers.get('content-type'));
    answered.set(key, answer);
    if (path === 'Invoices' && answer.status === 200 && state.loseAnswer) {
      state.loseAnswer = false;
      throw new TypeError('fetch failed');
    }
    return reply(answer.body, answer.status);
  }) as typeof fetch;

  restore = () => {
    globalThis.fetch = realFetch;
    config.xeroClientId = saved.id;
    config.xeroClientSecret = saved.secret;
    config.xeroFixtureFile = saved.file;
  };
  const writes = (path: string) => sent.filter((r) => r.method === 'PUT' && r.path === path);
  return { fixture, state, sent, files, writes, bills: () => fixture.Invoices.filter((i) => String(i.InvoiceID).startsWith('bill-')) };
}

/** Signed in to the organisation for real, with posting on a minute ago: what Go leaves. */
async function connectXero(orgId: string, { posting = true } = {}) {
  const far = new Date(Date.now() + 86_400_000);
  await prisma.accountingConnection.create({ data: {
    organizationId: orgId, provider: 'xero', environment: 'live', realmId: TENANT, accessToken: 'x', refreshToken: 'y',
    accessTokenExpiresAt: far, refreshTokenExpiresAt: far,
    ...(posting ? { postingEnabledAt: new Date(Date.now() - 60_000) } : {}),
  } });
}

/** Approve a bill as the approver it waits on; the post runs in the background. */
async function approve(w: Awaited<ReturnType<typeof makeWorld>>, billId = w.bills.submitted) {
  const inbox = await get(`/organizations/${w.orgId}/bills/approvals-inbox`, w.apprA.token);
  const mine = (inbox.waitingOnYou as Array<{ paymentOrderId: string; taskId: string }>).find((x) => x.paymentOrderId === billId)!;
  await post(`/organizations/${w.orgId}/approvals/tasks/${mine.taskId}/command`, { command: { kind: 'approve' }, idempotencyKey: crypto.randomUUID() }, w.apprA.token);
  await drainAsyncIntake();
  await drainBackgroundWork();
}

const syncOf = (billId: string) => prisma.accountingSync.findUnique({ where: { paymentOrderId_provider: { paymentOrderId: billId, provider: 'xero' } } });
const bodyOf = (r: { body: unknown }) => JSON.parse(String(r.body)) as Row;

test('xero: approving a bill posts it awaiting payment, its contact made, a line per Category, the invoice on it', async () => {
  const w = await makeWorld();
  const books = xero(organisation());
  await connectXero(w.orgId);
  await approve(w);

  const [contact] = books.writes('Contacts');
  assert.deepEqual(bodyOf(contact!), { Contacts: [{ Name: 'Submit Co' }] }, 'nobody by that name in Xero, so the contact is made');
  const [put] = books.writes('Invoices');
  assert.ok(put, 'one bill');
  assert.match(put.key ?? '', new RegExp(`^decimal_${w.bills.submitted}_bill_`), 'sent with a key of its own');
  assert.equal(contact!.key, `${put.key}_contact`);
  const bill = bodyOf(put).Invoices[0];
  assert.deepEqual(bill, {
    Type: 'ACCPAY',
    Contact: { ContactID: books.fixture.Contacts[0]!.ContactID },
    InvoiceNumber: 'SC-1',
    Date: '2026-08-02',
    DueDate: '2026-08-30',
    CurrencyCode: 'USD',
    LineAmountTypes: 'NoTax',
    Status: 'AUTHORISED',
    LineItems: [{ Description: 'Services', Quantity: 1, UnitAmount: 700, AccountCode: '485' }],
  }, 'the Category confirmed in review, by its code in Xero (it was recorded against the standard list, before Xero)');

  const posted = books.bills()[0]!;
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'synced');
  assert.equal(sync?.externalBillId, posted.InvoiceID);
  assert.equal(sync?.externalVendorId, books.fixture.Contacts[0]!.ContactID);
  assert.equal(Number(sync?.externalBillBalance), 700);
  assert.ok(books.sent.some((r) => r.method === 'GET' && r.path === `Invoices/${posted.InvoiceID}`), 'read back');

  assert.equal(books.files.length, 1, 'the invoice, on the bill');
  const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { paymentOrderId: w.bills.submitted }, include: { invoiceDocument: true } });
  assert.equal(books.files[0]!.billId, posted.InvoiceID);
  assert.equal(books.files[0]!.fileName, order.invoiceDocument!.filename);
  assert.equal(books.files[0]!.contentType, 'application/pdf');
  assert.ok(Buffer.from(order.invoiceDocument!.data).equals(books.files[0]!.bytes), 'the file as it was uploaded');
  assert.deepEqual(sync?.metadataJson, { attachmentId: 'file-3' });

  // Again, and through the sweep: still one bill.
  assert.equal(await syncApprovedBill(w.bills.submitted), 'skipped');
  await sweepUnsyncedSettledOrders();
  assert.equal(books.writes('Invoices').length, 1, 'never a second bill');
  assert.equal(await prisma.accountingSync.count({ where: { paymentOrderId: w.bills.submitted, provider: 'quickbooks' } }), 0, 'QuickBooks never hears of it');
});

test('xero: the contact Xero has by the bill\'s name is used, whatever its case, and an archived one is refused in words', async () => {
  const w = await makeWorld();
  const books = xero(organisation({ Contacts: [{ ContactID: 'c-submit', Name: 'SUBMIT CO', ContactStatus: 'ACTIVE', IsSupplier: true }] }));
  await connectXero(w.orgId);
  await approve(w);
  assert.equal(books.writes('Contacts').length, 0, 'not made twice');
  assert.equal(bodyOf(books.writes('Invoices')[0]!).Invoices[0].Contact.ContactID, 'c-submit');
  assert.equal((await syncOf(w.bills.submitted))?.status, 'synced');
  restore!();

  const other = await makeWorld('Archived Contact Ltd');
  const archived = xero(organisation({ Contacts: [{ ContactID: 'c-gone', Name: 'Submit Co', ContactStatus: 'ARCHIVED', IsSupplier: true }] }));
  await connectXero(other.orgId);
  await approve(other);
  const sync = await syncOf(other.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.equal(sync?.error, '"Submit Co" is archived in Xero. Restore the contact there, then retry.');
  assert.equal(archived.sent.filter((r) => r.method === 'PUT').length, 0, 'nothing written');
});

test('xero: a send whose answer never came is sent again with its key, so the bill that landed comes back and never a second', async () => {
  const w = await makeWorld();
  const books = xero(organisation());
  await connectXero(w.orgId);
  books.state.loseAnswer = true;
  await approve(w);

  const lost = await syncOf(w.bills.submitted);
  assert.equal(lost?.status, 'error');
  assert.equal(lost?.error, 'Xero didn’t answer in time. Decimal will try again by itself.');
  const first = books.writes('Invoices')[0]!;
  assert.deepEqual(lost?.metadataJson, { sending: { key: first.key, at: (lost?.metadataJson as Row).sending.at } }, 'it may be there: the send is kept');
  assert.equal(books.bills().length, 1, 'it landed');

  assert.equal(await syncApprovedBill(w.bills.submitted), 'synced');
  const [, again] = books.writes('Invoices');
  assert.equal(again?.key, first.key, 'the same send');
  assert.equal(books.bills().length, 1, 'still one bill');
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.externalBillId, books.bills()[0]!.InvoiceID);
  assert.equal(books.writes('Contacts').length, 1, 'the contact made the first time is found the second');
});

test('xero: when Xero refuses, nothing was made, so the next send gets a key of its own', async () => {
  const w = await makeWorld();
  const books = xero(organisation());
  await connectXero(w.orgId);
  books.state.refuse = 'Account code \'485\' has been archived, or deleted.';
  await approve(w);

  const refused = await syncOf(w.bills.submitted);
  assert.equal(refused?.status, 'error');
  assert.equal(refused?.error, 'Xero said: Account code \'485\' has been archived, or deleted.');
  assert.deepEqual(refused?.metadataJson, {}, 'nothing landed, so nothing is kept to send again');
  assert.equal(books.bills().length, 0);

  // Someone fixes it in Xero, and the retry goes through: a key Xero hasn't answered.
  assert.equal(await syncApprovedBill(w.bills.submitted), 'synced');
  const [first, second] = books.writes('Invoices');
  assert.notEqual(second?.key, first?.key);
  assert.equal(books.bills().length, 1);
});

test('xero: a bill dated on or before Xero\'s lock date doesn\'t post, and says why', async () => {
  const w = await makeWorld();
  const books = xero(organisation({}, { PeriodLockDate: xeroDate('2026-08-31') }));
  await connectXero(w.orgId);
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.equal(sync?.error, 'This bill is dated 2026-08-02, and the books are closed through 2026-08-31. Send it back to change the date, or reopen the period in Xero, then retry.');
  assert.equal(books.sent.filter((r) => r.method === 'PUT').length, 0);
});

test('xero: a bill Xero records at another total stays posted, never sent again, and says where to correct it', async () => {
  const w = await makeWorld();
  const books = xero(organisation());
  await connectXero(w.orgId);
  books.state.recordedTotal = 699.99;
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.equal(sync?.externalBillId, books.bills()[0]!.InvoiceID, 'it is in Xero');
  assert.equal(sync?.error, 'Xero recorded this bill at $699.99, and it was approved at $700.00. Correct bill SC-1 in Xero, then retry to check it again.');
  await sweepUnsyncedSettledOrders();
  assert.equal(books.writes('Invoices').length, 1);

  // Corrected there: a retry reads it again, and it holds.
  books.bills()[0]!.Total = 700;
  books.bills()[0]!.AmountDue = 700;
  assert.equal(await syncApprovedBill(w.bills.submitted), 'synced');
  assert.equal(books.writes('Invoices').length, 1);
});

test('xero: a bill already in Xero is held until someone says, and "same bill" links to it', async () => {
  const w = await makeWorld();
  const books = xero(organisation({
    Contacts: [{ ContactID: 'c-submit', Name: 'Submit Co', ContactStatus: 'ACTIVE', IsSupplier: true }],
    Invoices: [{
      InvoiceID: 'hand-1', Type: 'ACCPAY', Status: 'AUTHORISED', InvoiceNumber: 'SC-1', Contact: { ContactID: 'c-submit', Name: 'Submit Co' },
      Date: xeroDate('2026-08-02'), DueDate: xeroDate('2026-08-30'), LineAmountTypes: 'NoTax', CurrencyCode: 'USD',
      LineItems: [{ LineItemID: 'h-1', Description: 'Services', AccountCode: '485', LineAmount: 700, TaxAmount: 0 }],
      SubTotal: 700, TotalTax: 0, Total: 700, AmountDue: 700, UpdatedDateUTC: xeroDate('2026-08-03'),
    }],
  }));
  await connectXero(w.orgId);
  await approve(w);

  const held = await syncOf(w.bills.submitted);
  assert.equal(held?.status, 'held');
  assert.match(held?.error ?? '', /^Xero already has bill SC-1 from Submit Co for \$700\.00/);
  assert.equal(books.writes('Invoices').length, 0, 'nothing posts while nobody has said');

  const answer = await answerBooksMatch({ organizationId: w.orgId, paymentOrderId: w.bills.submitted, actorUserId: w.owner.userId, recordId: 'hand-1', same: true });
  assert.deepEqual(answer, { posting: 'synced', linked: true });
  const linked = await syncOf(w.bills.submitted);
  assert.equal(linked?.externalBillId, 'hand-1');
  assert.equal((linked?.metadataJson as Row).linkedFromBooks, true);
  assert.equal(books.writes('Invoices').length, 0, 'linked, never posted');
  assert.equal(books.files.length, 0, 'their own entry, with whatever they attached');
});

test('xero: a held bill\'s page shows what held it, when only the contact Decimal found in Xero makes it a match, and an answer from it goes through', async () => {
  const w = await makeWorld();
  // Keyed into Xero by hand without its number, under a contact Decimal's copy doesn't
  // have: only the contact Decimal finds by name makes it the same vendor's bill.
  xero(organisation({
    Contacts: [{ ContactID: 'c-submit', Name: 'Submit Co', ContactStatus: 'ACTIVE', IsSupplier: true }],
    Invoices: [{
      InvoiceID: 'hand-2', Type: 'ACCPAY', Status: 'AUTHORISED', Contact: { ContactID: 'c-submit', Name: 'Submit Co' },
      Date: xeroDate('2026-08-03'), DueDate: xeroDate('2026-08-31'), LineAmountTypes: 'NoTax', CurrencyCode: 'USD',
      LineItems: [{ LineItemID: 'h-2', Description: 'Services', AccountCode: '485', LineAmount: 700, TaxAmount: 0 }],
      SubTotal: 700, TotalTax: 0, Total: 700, AmountDue: 700, UpdatedDateUTC: xeroDate('2026-08-04'),
    }],
  }));
  await connectXero(w.orgId);
  await approve(w);
  assert.equal((await syncOf(w.bills.submitted))?.status, 'held');

  // Opening the bill must show the bill that held it, the moment it opens and after any look.
  const sameBill = (detail: Row) => detail.draft.flags.find((f: Row) => f.kind === 'in_books')?.resolutions.find((r: Row) => r.action === 'same_bill')?.targetId;
  const opened = await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token);
  assert.equal(sameBill(opened), 'hand-2', 'on the page as it opens');
  await drainBackgroundWork();
  assert.equal(sameBill(await get(`/organizations/${w.orgId}/bills/${w.bills.submitted}/detail`, w.owner.token)), 'hand-2', 'and after any look');

  const said = await post(`/organizations/${w.orgId}/bills/${w.bills.submitted}/in-books`, { recordId: 'hand-2', same: true }, w.owner.token);
  assert.equal(said.posting, 'synced');
  assert.equal(said.linked, true);
  assert.equal((await syncOf(w.bills.submitted))?.externalBillId, 'hand-2');
});

test('xero: once Xero is the team\'s books, Categories come from its chart, without bank, system or archived accounts', async () => {
  const w = await makeWorld();
  xero(organisation());
  await connectXero(w.orgId);
  const chart = await listChartOfAccounts(w.orgId);
  assert.deepEqual(chart.map((a) => [a.name, a.acctNum, a.accountType, a.classification]), [
    ['Cloud hosting & infrastructure', '485', 'Expense', 'Expense'],
    ['Travel', '493', 'Overhead', 'Expense'],
  ]);
  assert.deepEqual(await categoryNamesFor(w.orgId), ['Cloud hosting & infrastructure', 'Travel']);
});

test('xero: a team posts to one set of books: Go is refused while QuickBooks posts, and the latest yes is where bills go', async () => {
  const w = await makeWorld();
  const far = new Date(Date.now() + 86_400_000);
  await prisma.accountingConnection.create({ data: {
    organizationId: w.orgId, realmId: 'realm-test', accessToken: 'x', refreshToken: 'y', accessTokenExpiresAt: far, refreshTokenExpiresAt: far,
    postingEnabledAt: new Date(Date.now() - 120_000),
  } });
  const setup = await prisma.integrationSetup.create({ data: { organizationId: w.orgId, system: 'xero', startedByUserId: w.owner.userId } });
  const books = (await doneConditions(setup)).find((c) => c.key === 'one_set_of_books');
  assert.equal(books?.done, false);
  assert.equal(books?.missing, 'Bills already post to QuickBooks for this team, and Decimal posts to one set of books. Someone has to disconnect QuickBooks first, from its row in Organisation, under Accounting.');
  assert.equal((await postingTarget(w.orgId))?.system, 'quickbooks');

  await prisma.accountingConnection.updateMany({ where: { organizationId: w.orgId, provider: 'quickbooks' }, data: { status: 'disconnected', postingEnabledAt: null } });
  assert.equal((await doneConditions(setup)).find((c) => c.key === 'one_set_of_books')?.done, true, 'disconnected, it posts nowhere');
  await connectXero(w.orgId);
  assert.deepEqual(await postingTarget(w.orgId), { system: 'xero', companyId: TENANT, since: (await prisma.accountingConnection.findFirstOrThrow({ where: { organizationId: w.orgId, provider: 'xero' } })).postingEnabledAt, live: true });
});

test('xero: a bill approved on the bench\'s made-up organisation says nothing posts there, rather than waiting', async () => {
  const w = await makeWorld();
  const books = xero(organisation());
  const never = new Date('2100-01-01T00:00:00Z');
  await prisma.accountingConnection.create({ data: {
    organizationId: w.orgId, provider: 'xero', environment: 'fixture', realmId: TENANT, accessToken: 'fixture', refreshToken: 'fixture',
    accessTokenExpiresAt: never, refreshTokenExpiresAt: never, postingEnabledAt: new Date(Date.now() - 60_000),
  } });
  await approve(w);
  const sync = await syncOf(w.bills.submitted);
  assert.equal(sync?.status, 'error');
  assert.equal(sync?.error, 'This team’s Xero is the bench’s made-up organisation, which nothing posts to. Sign in to a real Xero organisation to post.');
  assert.equal(books.sent.length, 0, 'nothing went to Xero');
});
