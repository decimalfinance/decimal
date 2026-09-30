-- A chat can be about one bill: asked from the bill's own screen, where "this
-- bill" means that one. Null for chats started from home.
ALTER TABLE companion_chats ADD COLUMN IF NOT EXISTS bill_id UUID REFERENCES payment_orders (payment_order_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS companion_chats_bill_idx ON companion_chats (bill_id, user_id, updated_at DESC) WHERE bill_id IS NOT NULL;
