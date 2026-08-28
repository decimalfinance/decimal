-- Saying something about a bill without putting it on hold.
--
-- A QUESTION has teeth: it names one person, parks the bill in request_info,
-- and only that person (or a deed) can release it. That is the whole reason
-- "waiting on Zara" means something rather than being decoration.
--
-- Most of what people need to say about a bill is not that. Somebody who
-- onboarded the vendor knows they invoice under another name; somebody
-- recognises the amount; somebody wants to note why they left a line uncoded.
-- Before this there was nowhere for any of it, so it went to Slack and the bill
-- lost the half of its own story that explains the rest.
--
-- A comment is that, and nothing more: anyone who can see the bill can leave
-- one, and leaving one holds nothing up. Where it replies to a question the
-- thread says so — which is how somebody who was NOT asked can help answer
-- without being able to close what was put to somebody else.
CREATE TABLE IF NOT EXISTS bill_comments
(
  bill_comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  -- The question this is a reply to, when it is one. Null is a comment on the
  -- bill itself.
  in_reply_to_question_id UUID REFERENCES bill_questions(bill_question_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The thread is read in order, per bill, every time the draft screen opens.
CREATE INDEX IF NOT EXISTS idx_bill_comments_order_created_at
  ON bill_comments(payment_order_id, created_at);

-- Said, and therefore said. The same rule the rest of a bill's record follows:
-- a conversation somebody can quietly edit afterwards is not a record of what
-- happened, and this one sits beside decisions about money.
CREATE OR REPLACE FUNCTION bill_comments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bill_comments is append-only (attempted % on %)', TG_OP, OLD.bill_comment_id;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bill_comments_append_only ON bill_comments;
CREATE TRIGGER trg_bill_comments_append_only
  BEFORE UPDATE OR DELETE ON bill_comments
  FOR EACH ROW EXECUTE FUNCTION bill_comments_append_only();
