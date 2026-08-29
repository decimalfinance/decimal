// --- vendor addresses off a letterhead ---------------------------------------
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitPostalAddress, deriveInvoiceReference } from '../src/payments/bills.js';

test('a middle dot separates address parts just like a comma', () => {
  // Both of these are real B-series letterheads. Splitting on commas alone put
  // the city inside the street and left the city box reading "Not on document".
  assert.deepEqual(splitPostalAddress('500 Howard St · San Francisco, CA 94105'), {
    street: '500 Howard St', city: 'San Francisco', state: 'CA', zip: '94105', country: 'United States', countryInferred: true,
  });
  assert.deepEqual(splitPostalAddress('1 Beacon St · Boston, MA 02108'), {
    street: '1 Beacon St', city: 'Boston', state: 'MA', zip: '02108', country: 'United States', countryInferred: true,
  });
});

test('bullets and pipes separate too, and plain commas are unchanged', () => {
  assert.deepEqual(splitPostalAddress('12 Rutland St • Boston, MA 02118'), {
    street: '12 Rutland St', city: 'Boston', state: 'MA', zip: '02118', country: 'United States', countryInferred: true,
  });
  assert.deepEqual(splitPostalAddress('88 Harbor Rd | Oakland, CA 94607'), {
    street: '88 Harbor Rd', city: 'Oakland', state: 'CA', zip: '94607', country: 'United States', countryInferred: true,
  });
  assert.deepEqual(splitPostalAddress('660 Mission St, Floor 4, San Francisco, CA 94105'), {
    street: '660 Mission St, Floor 4', city: 'San Francisco', state: 'CA', zip: '94105', country: 'United States', countryInferred: true,
  });
});

test('an address it cannot split stays whole in street rather than vanishing', () => {
  assert.deepEqual(splitPostalAddress('Somewhere Unhelpful'), {
    street: 'Somewhere Unhelpful', city: null, state: null, zip: null, country: null, countryInferred: false,
  });
  assert.deepEqual(splitPostalAddress(null), { street: null, city: null, state: null, zip: null, country: null, countryInferred: false });
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
    street: '340 Congress St', city: 'Austin', state: 'TX', zip: '78701', country: 'United States', countryInferred: true,
  });

  // Windows line endings, and a blank line between, which a PDF text layer
  // produces as readily as a single break.
  assert.deepEqual(splitPostalAddress('9 Cannery Row\r\n\r\nMonterey, CA 93940'), {
    street: '9 Cannery Row', city: 'Monterey', state: 'CA', zip: '93940', country: 'United States', countryInferred: true,
  });

  // Mixed, because a document is free to use both.
  assert.deepEqual(splitPostalAddress('77 Industrial Pkwy · Suite 200\nColumbus, OH 43004'), {
    street: '77 Industrial Pkwy, Suite 200', city: 'Columbus', state: 'OH', zip: '43004', country: 'United States', countryInferred: true,
  });
});

test('a UK address puts London in the city and the postcode in the postcode', () => {
  // D4, exactly as it arrived: two lines flattened into one, a postcode that is
  // not five digits, and a country on the end. All of it landed in the street,
  // with "United Kingdom" filed as the city.
  assert.deepEqual(splitPostalAddress('14 Clerkenwell Road  London EC1M 5PA, United Kingdom'), {
    street: '14 Clerkenwell Road', city: 'London', state: null, zip: 'EC1M 5PA',
    // State stays null and that is the honest answer: the UK has none, and
    // repeating the county or the country there to fill the box would be worse
    // than an empty field.
    country: 'United Kingdom', countryInferred: false,
  });
});

test('a country on the end goes in the country box, not the city', () => {
  // It was briefly dropped, for want of anywhere to put it. A vendor abroad is
  // the case this product exists for, so it has a box of its own.
  assert.deepEqual(splitPostalAddress('9 Cannery Row, Monterey, CA 93940, USA'), {
    street: '9 Cannery Row', city: 'Monterey', state: 'CA', zip: '93940', country: 'USA', countryInferred: false,
  });
});

test('other postcode shapes reach the postcode box too', () => {
  // Canada writes them differently again, and the rest of the world is not an
  // edge case — it is most invoices sent to a company that buys abroad.
  assert.deepEqual(splitPostalAddress('120 Bloor St W, Toronto M5S 1M8, Canada'), {
    street: '120 Bloor St W', city: 'Toronto', state: null, zip: 'M5S 1M8', country: 'Canada', countryInferred: false,
  });
});

test('a run of spaces separates, because a flattened line break looks like one', () => {
  // The model returns two lines as one string with the break collapsed. Read as
  // ordinary spacing, the city stays inside the street.
  assert.deepEqual(splitPostalAddress('340 Congress St   Austin, TX 78701'), {
    street: '340 Congress St', city: 'Austin', state: 'TX', zip: '78701', country: 'United States', countryInferred: true,
  });
});

test('a US invoice that prints no country still gets one', () => {
  // Most US invoices simply do not print it, and leaving the box empty on
  // "New York, NY 10010" is pedantry rather than rigour: the postal format
  // says it plainly.
  const r = splitPostalAddress('210 5th Ave · New York, NY 10010');
  assert.equal(r.country, 'United States');
  // And it says it was worked out. Everything else on the bill screen shows
  // only what the document says; this is the one field allowed to break that,
  // so it is the one field that has to admit it.
  assert.equal(r.countryInferred, true);
});

test('a country actually printed is read, not inferred', () => {
  const r = splitPostalAddress('9 Cannery Row, Monterey, CA 93940, USA');
  assert.equal(r.country, 'USA');
  assert.equal(r.countryInferred, false, 'read off the page, so nothing was worked out');
});

test('other decisive postal shapes are recognised too', () => {
  assert.equal(splitPostalAddress('14 Clerkenwell Road  London EC1M 5PA').country, 'United Kingdom');
  assert.equal(splitPostalAddress('120 Bloor St W, Toronto M5S 1M8').country, 'Canada');
});

test('an address that does not settle the question is left alone', () => {
  // Inferred ONLY from a format that admits one answer. A city name would be
  // the guess doing real work, and a wrong country is worse than an empty box
  // because it looks authoritative.
  const r = splitPostalAddress('12 Rue de Rivoli, Paris');
  assert.equal(r.country, null);
  assert.equal(r.countryInferred, false);
  // "TX" without a zip settles nothing either — plenty of places abbreviate.
  assert.equal(splitPostalAddress('1 Main St, Springfield, TX').country, null);
});

test('a five-digit number alone is not a US address', () => {
  // German postcodes are five digits too. Without a US state beside it the
  // format is not decisive, so nothing is claimed.
  assert.equal(splitPostalAddress('Hauptstrasse 12, Berlin 10115').country, null);
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
