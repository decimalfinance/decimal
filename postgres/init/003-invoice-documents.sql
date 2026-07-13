-- Invoice document storage: the uploaded file (PDF/image) is kept verbatim so the
-- review screen can render the original document next to the extracted fields.
-- Idempotent; applied by scripts/db-setup.sh after 001/002.

CREATE TABLE IF NOT EXISTS invoice_documents
(
  invoice_document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  filename            TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  sha256              TEXT NOT NULL,
  data                BYTEA NOT NULL,
  page_count          INTEGER,
  uploaded_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-uploading the same file into the same org reuses the stored row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_documents_org_sha256
  ON invoice_documents(organization_id, sha256);

CREATE INDEX IF NOT EXISTS idx_invoice_documents_org_created_at
  ON invoice_documents(organization_id, created_at DESC);

-- Async intake: the document row exists (and is viewable) while extraction runs.
ALTER TABLE invoice_documents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE invoice_documents
  ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE invoice_documents
  DROP CONSTRAINT IF EXISTS chk_invoice_documents_status;
ALTER TABLE invoice_documents
  ADD CONSTRAINT chk_invoice_documents_status CHECK (status IN ('processing', 'processed', 'failed'));

-- Rendered page images (PNG) — the review screen shows these, not a PDF viewer.
CREATE TABLE IF NOT EXISTS invoice_document_pages
(
  invoice_document_page_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_document_id      UUID NOT NULL REFERENCES invoice_documents(invoice_document_id) ON DELETE CASCADE,
  page_index               INTEGER NOT NULL,
  mime_type                TEXT NOT NULL,
  data                     BYTEA NOT NULL,
  UNIQUE (invoice_document_id, page_index)
);

-- Each payment order created from an upload points back at its source document.
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS invoice_document_id UUID REFERENCES invoice_documents(invoice_document_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_orders_invoice_document
  ON payment_orders(invoice_document_id);
