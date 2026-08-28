-- A comment can reply to another comment, not only to a question.
--
-- The conversation on a bill is not one stream, it is several: a bill collects
-- questions about different things, and a flat list makes reading the third one
-- mean scrolling through the first two. So each question — and each remark
-- raised on its own — is the root of its own thread, and everything said about
-- it hangs underneath and folds away when it is done.
--
-- Two levels, not arbitrary depth. Slack's shape rather than Reddit's, and
-- deliberately: what makes this useful is knowing which SUBJECT a remark is
-- about, and a reply-to-a-reply-to-a-reply answers that question no better
-- while making the thing much harder to read on a 40% pane. A reply to a reply
-- attaches to the same root, flattened by commentOnBill.
ALTER TABLE bill_comments
  ADD COLUMN IF NOT EXISTS in_reply_to_comment_id UUID
  REFERENCES bill_comments(bill_comment_id) ON DELETE CASCADE;

-- Reading a thread means finding everything under one root.
CREATE INDEX IF NOT EXISTS idx_bill_comments_reply_to_comment
  ON bill_comments(in_reply_to_comment_id) WHERE in_reply_to_comment_id IS NOT NULL;

-- A comment answers to one root or none: a remark on the bill, a reply to a
-- question, or a reply to a comment — never two at once, which would put the
-- same sentence in two conversations.
ALTER TABLE bill_comments
  DROP CONSTRAINT IF EXISTS bill_comments_one_parent;
ALTER TABLE bill_comments
  ADD CONSTRAINT bill_comments_one_parent
  CHECK (in_reply_to_question_id IS NULL OR in_reply_to_comment_id IS NULL);
