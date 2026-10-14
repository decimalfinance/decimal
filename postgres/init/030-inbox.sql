-- The inbox: what each person has to do, one item per bill.
--
-- Every line is derived from state, never stored: your approval is waiting, a
-- question was asked of you, a reply came to one you asked, a draft needs
-- review. So it clears itself the moment the state moves.
--
-- Nudges (inbox_asks) were removed on 2026-10-14. Once a question stopped
-- holding the bill, a nudge no longer worked differently from a question, and
-- two kinds of ask only confused people. Every ask is a question now.
DROP TABLE IF EXISTS inbox_asks;

-- When each person last looked at their item for a bill. An item is "new"
-- when anything in it is later than this.
CREATE TABLE IF NOT EXISTS inbox_seen
(
  organization_id  UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  payment_order_id UUID NOT NULL REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id, payment_order_id)
);
