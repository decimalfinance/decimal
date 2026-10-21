-- A question is answered in the bill's conversation (2026-10-21). Somebody
-- types a message, and Decimal judges whether it answers an open question:
-- the person asked, or anyone else who works on bills, may answer by simply
-- saying it. The question keeps the message that answered it, so the thread
-- shows the words once, as that person's own message, and the question only
-- says who answered it.
--
-- answer_via says how a question was answered:
--   'message'  in the conversation; answer_comment_id is that message
--   'deed'     a deed did what it asked (question-settle.ts)
--   'words'    typed into the answer box the bill page used to have
-- Null on rows from before this existed.
ALTER TABLE bill_questions ADD COLUMN IF NOT EXISTS answer_comment_id uuid REFERENCES bill_comments (bill_comment_id);
ALTER TABLE bill_questions ADD COLUMN IF NOT EXISTS answer_via text;

ALTER TABLE bill_questions DROP CONSTRAINT IF EXISTS bill_questions_answer_via_check;
ALTER TABLE bill_questions ADD CONSTRAINT bill_questions_answer_via_check
  CHECK (answer_via IS NULL OR answer_via IN ('message', 'deed', 'words'));

-- Questions a deed settled before this existed: the settling event was written
-- at the same instant as the answer.
UPDATE bill_questions q SET answer_via = 'deed'
WHERE q.answer_via IS NULL
  AND q.answered_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM payment_order_events e
    WHERE e.payment_order_id = q.payment_order_id
      AND e.event_type = 'bill_question_settled'
      AND e.created_at = q.answered_at
  );
