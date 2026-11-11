-- Until 11 Nov 2026 Decimal couldn't post to Xero, and a Xero setup's Go was a
-- rehearsal: it kept the person's yes, and said plainly that nothing would post.
-- Since then a yes to Xero turns posting on, so a rehearsal's yes would start
-- posting that nobody agreed to. Those yeses are let go. Every yes since was given
-- knowing bills post, and the cutoff leaves it alone, however often this runs.
UPDATE accounting_connections
SET posting_enabled_at = NULL, posting_enabled_by_user_id = NULL, updated_at = now()
WHERE provider = 'xero'
  AND posting_enabled_at IS NOT NULL
  AND posting_enabled_at < TIMESTAMPTZ '2026-11-11 18:30:00+00';
