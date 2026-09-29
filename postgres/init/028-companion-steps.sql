-- The companion's work, one step at a time.
--
-- A job is what the companion does with one document: open it, read it, check
-- every figure against the page, find the vendor, pick categories, look for
-- duplicates, and say whether the bill is ready. Each of those is a row here,
-- written as it starts and finished as it ends, so a person can watch the work
-- happen instead of being told about it afterwards.
--
-- The sentence is written by the server, once. Screens show it; they do not
-- rephrase it.
CREATE TABLE IF NOT EXISTS companion_steps
(
  step_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  -- The job: the document the work is about.
  invoice_document_id UUID NOT NULL REFERENCES invoice_documents (invoice_document_id) ON DELETE CASCADE,
  -- Set once a step is about a particular bill made from the document.
  payment_order_id    UUID REFERENCES payment_orders (payment_order_id) ON DELETE CASCADE,
  -- A stable key for the kind of step ('read', 'vendor', 'duplicates', ...).
  kind                TEXT NOT NULL,
  -- running while it happens; then done, noted (done, with something worth a
  -- look) or failed.
  status              TEXT NOT NULL DEFAULT 'running',
  text                TEXT NOT NULL,
  detail              TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS companion_steps_job_idx
  ON companion_steps (invoice_document_id, started_at);
CREATE INDEX IF NOT EXISTS companion_steps_org_running_idx
  ON companion_steps (organization_id) WHERE status = 'running';
