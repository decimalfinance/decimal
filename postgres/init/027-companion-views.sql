-- When each person last looked at the companion's briefing.
--
-- The briefing covers "since you last looked", so it needs two moments: the
-- start of the current visit and the start of the one before. Refreshing the
-- page must not reset the window — only a gap of more than half an hour counts
-- as a new visit — so the window a person reads stays put while they read it.
CREATE TABLE IF NOT EXISTS companion_views
(
  organization_id  UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  -- Start of the previous visit: the briefing reports everything since here.
  -- NULL on a first visit, when there is no "since" and it reports what is open.
  previous_seen_at TIMESTAMPTZ,
  -- Start of the current visit, refreshed while the visit continues.
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);
