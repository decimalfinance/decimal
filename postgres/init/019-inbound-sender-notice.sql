-- Whether we told the sender their email produced nothing.
--
-- Until now every rejection was silent. A colleague forwarded an invoice, we
-- decided there was no invoice in it, and they heard nothing back — so they
-- assumed it had landed. Mail that vanishes without a word is the worst
-- failure this door has, worse than a slightly noisy reply, because the person
-- who could fix it in ten seconds never finds out there is anything to fix.
--
-- Two columns rather than a boolean: the timestamp is the once-only guard, and
-- the kind records what we told them, so "we said the wrong thing to people
-- who sent a HEIC" is answerable later.
--
-- The guard matters more than it looks. A member's out-of-office auto-reply
-- lands back at the intake address with no attachment, which is itself a
-- rejection, which would earn another notice, which their auto-responder would
-- answer again. `sender_notified_at` is what stops that loop from ever getting
-- to a second lap; RFC 3834's Auto-Submitted check (in code) stops the first.
ALTER TABLE inbound_email_messages
  ADD COLUMN IF NOT EXISTS sender_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sender_notice_kind TEXT;
