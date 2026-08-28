// --- vendor addresses off a letterhead ---------------------------------------
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitPostalAddress, deriveInvoiceReference } from '../src/payments/bills.js';

test('a middle dot separates address parts just like a comma', () => {
  // Both of these are real B-series letterheads. Splitting on commas alone put
  // the city inside the street and left the city box reading "Not on document".
  assert.deepEqual(splitPostalAddress('500 Howard St · San Francisco, CA 94105'), {
    street: '500 Howard St', city: 'San Francisco', state: 'CA', zip: '94105',
  });
  assert.deepEqual(splitPostalAddress('1 Beacon St · Boston, MA 02108'), {
    street: '1 Beacon St', city: 'Boston', state: 'MA', zip: '02108',
  });
});

test('bullets and pipes separate too, and plain commas are unchanged', () => {
  assert.deepEqual(splitPostalAddress('12 Rutland St • Boston, MA 02118'), {
    street: '12 Rutland St', city: 'Boston', state: 'MA', zip: '02118',
  });
  assert.deepEqual(splitPostalAddress('88 Harbor Rd | Oakland, CA 94607'), {
    street: '88 Harbor Rd', city: 'Oakland', state: 'CA', zip: '94607',
  });
  assert.deepEqual(splitPostalAddress('660 Mission St, Floor 4, San Francisco, CA 94105'), {
    street: '660 Mission St, Floor 4', city: 'San Francisco', state: 'CA', zip: '94105',
  });
});

test('an address it cannot split stays whole in street rather than vanishing', () => {
  assert.deepEqual(splitPostalAddress('Somewhere Unhelpful'), {
    street: 'Somewhere Unhelpful', city: null, state: null, zip: null,
  });
  assert.deepEqual(splitPostalAddress(null), { street: null, city: null, state: null, zip: null });
});

test('a letterhead written across two lines splits like any other', () => {
  // The separator a letterhead actually uses, and the one this never saw:
  //
  //     340 Congress St
  //     Austin, TX 78701
  //
  // It only began arriving when extraction started reading the PDF's own text.
  // pdftotext preserves the document's line breaks; the vision model had been
  // quietly turning them into "·". So this function was correct against every
  // input it had ever been given and wrong about the format the document is
  // written in — the street came out "340 Congress St\nAustin", which a browser
  // then collapses into "340 Congress StAustin".
  assert.deepEqual(splitPostalAddress('340 Congress St\nAustin, TX 78701'), {
    street: '340 Congress St', city: 'Austin', state: 'TX', zip: '78701',
  });

  // Windows line endings, and a blank line between, which a PDF text layer
  // produces as readily as a single break.
  assert.deepEqual(splitPostalAddress('9 Cannery Row\r\n\r\nMonterey, CA 93940'), {
    street: '9 Cannery Row', city: 'Monterey', state: 'CA', zip: '93940',
  });

  // Mixed, because a document is free to use both.
  assert.deepEqual(splitPostalAddress('77 Industrial Pkwy · Suite 200\nColumbus, OH 43004'), {
    street: '77 Industrial Pkwy, Suite 200', city: 'Columbus', state: 'OH', zip: '43004',
  });
});

// --- a reference for an invoice that prints none -----------------------------
//
// AP teams do not reject a numberless invoice; they construct a reference from
// a written convention and note that they did. The property that matters is not
// that a reference EXISTS but that the same invoice always derives the same
// one — duplicate detection keys on vendor plus number, so "VANTAGE-AUG" from
// one clerk and "Vantage 8/15" from another means the same bill is paid twice.

test('a reference reads like an invoice number, not a sentence', () => {
  // It will be read as one everywhere it appears: the bill list, the ledger,
  // quoted back to a vendor. Initials so a human can tell whose it is, the
  // invoice date so it can be checked against the page, the amount so two
  // bills from one vendor on one day do not collide.
  assert.equal(
    deriveInvoiceReference({
      vendorName: 'Vantage Print Co', amount: 1500, invoiceDate: '2026-08-15',
    }),
    'VPC-260815-1500',
  );
});

test('the same invoice always derives the same reference', () => {
  // The whole point. Spacing and punctuation in the vendor name are exactly how
  // two spellings of one company stop matching each other.
  const a = deriveInvoiceReference({ vendorName: 'Vantage Print Co.', amount: 1500, invoiceDate: '2026-08-15' });
  const b = deriveInvoiceReference({ vendorName: 'Vantage  Print   Co', amount: 1500.0, invoiceDate: '2026-08-15' });
  assert.equal(a, b);
});

test('cents appear only when there are cents', () => {
  // Trailing zeros are noise on the overwhelming majority of bills.
  assert.equal(
    deriveInvoiceReference({ vendorName: 'Acme Cloud', amount: 1500.5, invoiceDate: '2026-08-15' }),
    'AC-260815-1500.50',
  );
  assert.equal(
    deriveInvoiceReference({ vendorName: 'Acme Cloud', amount: 1500, invoiceDate: '2026-08-15' }),
    'AC-260815-1500',
  );
});

test('two bills from one vendor on different days do not collide', () => {
  assert.notEqual(
    deriveInvoiceReference({ vendorName: 'Acme', amount: 1500, invoiceDate: '2026-08-15' }),
    deriveInvoiceReference({ vendorName: 'Acme', amount: 1500, invoiceDate: '2026-09-15' }),
  );
  // Nor two on the SAME day for different amounts, which is the case the amount
  // is carried for.
  assert.notEqual(
    deriveInvoiceReference({ vendorName: 'Acme', amount: 1500, invoiceDate: '2026-08-15' }),
    deriveInvoiceReference({ vendorName: 'Acme', amount: 900, invoiceDate: '2026-08-15' }),
  );
});

test('a missing invoice date falls back to the due date', () => {
  assert.equal(
    deriveInvoiceReference({ vendorName: 'Acme', amount: 200, invoiceDate: null, dueDate: '2026-12-01' }),
    'A-261201-200',
  );
});

test('initials alone are not a reference', () => {
  // Every bill from that vendor would collide, which is worse than having none:
  // duplicate detection would fire on unrelated invoices.
  assert.equal(deriveInvoiceReference({ vendorName: 'Acme' }), null);
  assert.equal(deriveInvoiceReference({ vendorName: null, amount: 100 }), null);
  assert.equal(deriveInvoiceReference({ vendorName: '///', amount: 100, invoiceDate: '2026-08-15' }), null);
});
