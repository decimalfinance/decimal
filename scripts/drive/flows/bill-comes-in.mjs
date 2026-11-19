// A bill comes in. A clerk drops a clean invoice on an empty Bills page, the
// model reads it, and the bill opens in review showing what the document says.
// Proves: upload -> extraction -> the bill page shows the vendor, number, total
// and lines, and the same values are what was stored.
// Needs an empty team, because an empty Bills page uploads on drop:
//   node scripts/drive/drive.mjs seed && node scripts/drive/drive.mjs run scripts/drive/flows/bill-comes-in.mjs
// About 10 s, most of it the model reading the PDF.
const PDF = 'synthetic_data/invoices/A-routing/A3-first-bill-312.pdf';
const BILL_PAGE = /\/bills\/([0-9a-f-]{36})/;

export default async function billComesIn(d) {
  await d.as('maya');
  await d.goto('bills');
  await d.upload(PDF);
  await d.see('$312.40', { timeout: 120_000 });
  if (!BILL_PAGE.test(d.page.url())) await d.click('$312.40');
  await d.waitUrl(BILL_PAGE);
  await d.see('In review');

  const screen = await d.read();
  const shown = (label) => screen.fields.find((f) => f.label === label)?.value;
  d.check(shown('Vendor name') === 'Juniper Office Supply', `vendor shows "${shown('Vendor name')}"`);
  d.check(shown('Invoice number') === 'JOS-1147', `invoice number shows "${shown('Invoice number')}"`);
  d.check(shown('Total due') === '$312.40', `total shows "${shown('Total due')}"`);
  const lineAmounts = screen.fields.filter((f) => /^Line \d+ amount$/.test(f.label)).map((f) => f.value);
  d.check(lineAmounts.length === 4, `${lineAmounts.length} lines shown, expected 4`);
  await d.shot('bill-in-review');

  // What was stored, not just what is on screen.
  const billId = d.page.url().match(BILL_PAGE)[1];
  const { data } = await d.api('GET', `bills/${billId}/detail`);
  const stored = Object.fromEntries(data.draft.fields.map((f) => [f.key, f.value]));
  d.check(data.draft.state === 'draft', `stored state is ${data.draft.state}`);
  d.check(data.draft.vendor.name === 'Juniper Office Supply', `stored vendor is ${data.draft.vendor.name}`);
  d.check(stored.invoiceNumber === 'JOS-1147', `stored invoice number is ${stored.invoiceNumber}`);
  const linesTotal = data.draft.lines.reduce((sum, l) => sum + Math.round(l.amount * 100), 0);
  d.check(linesTotal === 31240, `stored lines add up to ${linesTotal} cents, expected 31240`);

  return { billId, vendor: data.draft.vendor.name, lines: data.draft.lines.length, link: d.url(`bills/${billId}`) };
}
