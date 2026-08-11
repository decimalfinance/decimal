-- Other names this organization answers to.
--
-- A bill addressed to "Halcyon Labs, Inc." when you are "Decimal Labs" is
-- flagged as possibly not yours, which is right — paying a stranger's invoice
-- in full is the failure that check exists to stop. But subsidiaries, DBAs and
-- former names are real, and a flag you can only dismiss is one you dismiss
-- every month until you stop reading it.
--
-- Recording the name instead means the correction happens once. Deliberately an
-- ORG-level fact rather than a per-bill override: it is a claim about who the
-- organization is, which is why only an owner or admin may add one.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS trading_names JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN organizations.trading_names IS
  'Other names this org answers to (subsidiaries, DBAs, former names). Each entry: {name, addedByUserId, addedByName, addedAt, fromPaymentOrderId}. Owner/admin only.';
