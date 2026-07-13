-- The approval-flow builder's draft. The published flow lives in the engine
-- policy; unpublished edits (from the AI or by hand) are a per-org draft that
-- must survive navigating away and back. One row per org; cleared on publish.
CREATE TABLE IF NOT EXISTS approval.flow_drafts (
  organization_id uuid PRIMARY KEY REFERENCES organizations(organization_id),
  body            jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
