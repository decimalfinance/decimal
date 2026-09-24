-- What the exception agent found when a flag fired, and what it recommends.
--
-- A flag says something is wrong. It used to stop there: "possible duplicate of
-- BW-2210", and a person opened both bills and did the investigation by hand.
-- A brief is that investigation, done before anyone looks, with evidence and a
-- recommended resolution the person confirms or overrides.
--
-- ONE BRIEF PER PAIR, not per bill. A duplicate flag sits on both bills of a
-- pair; investigating each side separately costs two model calls and can
-- produce two contradictory verdicts about one fact. `pair_key` is a hash of the
-- two bill ids in sorted order, so either bill finds the same row, and each
-- derives its own recommended action from the verdict and which side it is on.
--
-- Mutable on purpose, unlike ai_suggestions: this is the CURRENT view of a
-- pair, re-investigated when the evidence changes (see `fingerprint`). The
-- append-only record of what was ever recommended, and what the human did about
-- it, is the suggestion log — `ai_suggestion_id` links to it.
--
-- A brief never gates anything. Every policy gate still runs on live state.
CREATE TABLE IF NOT EXISTS bill_exception_briefs
(
  brief_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  flag_kind                TEXT NOT NULL,
  pair_key                 TEXT NOT NULL,
  -- The two bills, lower id first. The pair is unordered; "older" and "newer"
  -- are decided from created_at when a recommendation is derived, not stored.
  first_payment_order_id   UUID NOT NULL REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  second_payment_order_id  UUID NOT NULL REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  status                   TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  -- A hash of the evidence the run was started against. Duplicates are
  -- recomputed live on every read, so a brief goes stale without either bill
  -- being edited — a twin cancelled, one side cleared. A mismatch re-runs it.
  fingerprint              TEXT NOT NULL,
  -- Only one run per pair at a time. Claimed atomically by an upsert that
  -- succeeds only when nothing is running or the previous lease expired.
  lease_until              TIMESTAMPTZ,
  verdict                  TEXT CHECK (verdict IN ('duplicate', 'replacement', 'not_duplicate', 'unsure')),
  headline                 TEXT,
  reason                   TEXT,
  confidence               TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  findings                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  could_not_check          JSONB NOT NULL DEFAULT '[]'::jsonb,
  model                    TEXT,
  latency_ms               INTEGER,
  prompt_tokens            INTEGER,
  completion_tokens        INTEGER,
  turns                    INTEGER,
  error                    TEXT,
  ai_suggestion_id         UUID REFERENCES ai_suggestions (ai_suggestion_id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bill_exception_briefs_pair UNIQUE (pair_key, flag_kind)
);

CREATE INDEX IF NOT EXISTS idx_bill_exception_briefs_first ON bill_exception_briefs (first_payment_order_id);
CREATE INDEX IF NOT EXISTS idx_bill_exception_briefs_second ON bill_exception_briefs (second_payment_order_id);
CREATE INDEX IF NOT EXISTS idx_bill_exception_briefs_org ON bill_exception_briefs (organization_id, updated_at DESC);
