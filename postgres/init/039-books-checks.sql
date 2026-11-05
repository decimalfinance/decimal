-- Whether a bill is in the books already. Someone may have entered it there by
-- hand, and QuickBooks takes a second bill with the same number from the same
-- vendor without a word, so posting it as well would put it in twice. Checked
-- live (accounting/books-check.ts) and written here, so every screen says the same
-- thing; what a person said about it is kept here too.
CREATE TABLE IF NOT EXISTS bill_books_checks
(
  payment_order_id UUID PRIMARY KEY REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  organization_id  UUID        NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  system           TEXT        NOT NULL,
  company_id       TEXT        NOT NULL,
  -- running, ready or failed.
  status           TEXT        NOT NULL DEFAULT 'running',
  -- What was looked for: the vendor, number, amount and date. A change looks again.
  fingerprint      TEXT        NOT NULL,
  lease_until      TIMESTAMPTZ,
  -- The bills in the books this one could be:
  -- [{recordId, number, vendorId, vendorName, date, totalMinor, currency, open, enteredAt, why}].
  matches          JSONB       NOT NULL DEFAULT '[]',
  error            TEXT,
  checked_at       TIMESTAMPTZ,
  -- What people said, one answer per bill in the books: [{recordId, same, byUserId, at}].
  -- Kept when it is checked again; dropped when the books are another company's.
  answers          JSONB       NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bill_books_checks_by_org ON bill_books_checks (organization_id);
