-- Every change to a bill's facts: who, what, when, from what, to what.
--
-- A trail already existed, as a `corrections` array inside the bill's metadata
-- jsonb. It carried the field, the read value, the corrected value and (on one
-- of the two write paths) a user id. Three things it could not do:
--
--   no timestamp     "who changed the ZIP" was answerable, "when" was not
--   not queryable    buried in jsonb per bill, so "every change this person
--                    made", or "every time anyone corrected a total", meant
--                    scanning every bill
--   not durable      part of a row that is rewritten on every edit, so a bug
--                    in one write path could silently drop the history
--
-- Rows here are INSERT-only. Nothing updates or deletes them; the current value
-- lives on the bill, and this is the record of how it got there. An accounting
-- product is asked this question by auditors, and "it is in a JSON blob
-- somewhere" is not an answer.
CREATE TABLE IF NOT EXISTS bill_field_changes
(
  bill_field_change_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (organization_id),
  payment_order_id     UUID NOT NULL REFERENCES payment_orders (payment_order_id),
  -- Review-screen field key: 'total', 'remitTo.zip', 'vendor.name'.
  field_key            TEXT NOT NULL,
  previous_value       TEXT,
  new_value            TEXT,
  -- Who, and null for a machine write so a person is never blamed for one.
  changed_by_user_id   UUID REFERENCES users (user_id),
  -- 'review' | 'approval' — the same edit means different things at different
  -- stages, and an auditor asks when in the process it happened.
  phase                TEXT,
  -- Why, when we know: 'confirm', 'edit', 'answered_question'.
  reason               TEXT,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The three questions actually asked of this table.
CREATE INDEX IF NOT EXISTS idx_bill_field_changes_order
  ON bill_field_changes (payment_order_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bill_field_changes_actor
  ON bill_field_changes (organization_id, changed_by_user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bill_field_changes_field
  ON bill_field_changes (organization_id, field_key, changed_at DESC);

-- Correlation id: which request produced this change. Free to add now, a
-- backfill nobody can do later — a change with no way to tie it to the request
-- that caused it cannot be explained after the fact.
ALTER TABLE bill_field_changes
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Who the actor IS, not just which user row. A background sweep writing under a
-- vague identity makes the whole trail less trustworthy, and 'system' must be
-- distinguishable from a person rather than inferred from a null.
ALTER TABLE bill_field_changes
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'user';

ALTER TABLE bill_field_changes DROP CONSTRAINT IF EXISTS bill_field_changes_actor_type_check;
ALTER TABLE bill_field_changes ADD CONSTRAINT bill_field_changes_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'agent'));

-- Immutability, enforced by a trigger rather than by grants.
--
-- REVOKE does not stop a table's OWNER, and the application connects as the
-- owner — so revoking UPDATE/DELETE looked like protection and was theatre. A
-- trigger fires regardless of who is asking, including the owner and including
-- a bug in our own code.
--
-- This is the same mechanism the approval engine already uses to keep policies
-- append-only, so there is one idea here rather than two.
CREATE OR REPLACE FUNCTION forbid_field_change_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bill_field_changes is append-only: an audit row cannot be edited or deleted';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bill_field_changes_immutable ON bill_field_changes;
CREATE TRIGGER trg_bill_field_changes_immutable
  BEFORE UPDATE OR DELETE ON bill_field_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_field_change_mutation();
