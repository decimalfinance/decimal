-- The inbox: what each person has to do, one item per bill.
--
-- An item has two kinds of line. What the system needs (your approval is
-- waiting, a question was asked of you, a draft needs review) is derived from
-- the bill's state every time and never stored, so it clears itself the moment
-- the state moves. What PEOPLE ask ("while you're in there, check the tax
-- line") is stored here, as a line on the recipient's item for that bill —
-- never as an item of its own, so nobody sees the same bill twice.
CREATE TABLE IF NOT EXISTS inbox_asks
(
  ask_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  payment_order_id UUID NOT NULL REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  to_user_id       UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  from_user_id     UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  -- Sent from a companion card (the person clicked), or by hand.
  via              TEXT NOT NULL DEFAULT 'person',
  text             TEXT NOT NULL,
  -- open until the recipient acts on the bill, ticks it, or the bill closes.
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  closed_reason    TEXT
);

CREATE INDEX IF NOT EXISTS inbox_asks_recipient_idx
  ON inbox_asks (organization_id, to_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS inbox_asks_bill_idx
  ON inbox_asks (payment_order_id);

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
