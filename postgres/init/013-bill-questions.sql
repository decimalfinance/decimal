-- Who gets asked what, and whether they answer.
--
-- Asking a colleague about a bill is already possible through the approval
-- engine (request_info parks the bill until answered). What was missing is any
-- record of the ASKING as a thing in its own right: who was asked, about which
-- bill, on whose behalf, and whether an answer ever came.
--
-- That record is the point. Over time it says who actually supplies missing
-- bill details, who answers quickly, and who is asked most about a given vendor
-- — which is what lets the product eventually suggest a recipient instead of
-- presenting an empty dropdown. Deliberately recorded before anything suggests
-- anything: a suggestion built on no history is a guess with a confident face.
CREATE TABLE IF NOT EXISTS bill_questions
(
  bill_question_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (organization_id),
  payment_order_id  UUID NOT NULL REFERENCES payment_orders (payment_order_id),
  -- The engine task this parked, when it went through request_info. Nullable
  -- because a question can outlive the plan that carried it.
  task_id           UUID,
  asked_by_user_id  UUID NOT NULL REFERENCES users (user_id),
  asked_of_user_id  UUID NOT NULL REFERENCES users (user_id),
  question          TEXT NOT NULL,
  -- What the question was about, so routing can be learned per flag rather than
  -- as one undifferentiated pile.
  about_flag        TEXT,
  answer            TEXT,
  answered_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Who do we ask about this vendor / this kind of problem, and do they reply?"
CREATE INDEX IF NOT EXISTS idx_bill_questions_asked_of
  ON bill_questions (organization_id, asked_of_user_id, answered_at);
CREATE INDEX IF NOT EXISTS idx_bill_questions_order
  ON bill_questions (payment_order_id, created_at DESC);
