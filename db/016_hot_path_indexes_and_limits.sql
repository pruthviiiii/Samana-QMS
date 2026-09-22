-- 016: indexes for the three queries on a timer, and an atomic rate limiter.
--
-- 1. Unread notifications are read on every queue refresh, the outbox claim
--    runs every 15 seconds, and the lookup reuse check runs on every check-in.
--    All three planned as sequential scans, which is free on an empty table and
--    expensive after a year of visits.
-- 2. The audit trail filtered by action walked the whole table.
-- 3. qms.rate_limits keyed on (key, window_start) needed the caller to pick the
--    window before inserting, so two requests arriving together could open two
--    windows and spend the budget twice. One row per key lets the whole
--    decision be a single atomic upsert (see rateLimit in lib/http.ts).
--    Existing rows are transient counters; clearing them resets live windows.

CREATE INDEX IF NOT EXISTS notifications_unread
  ON qms.notifications (user_id, id DESC) WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS outbox_ready
  ON qms.outbox (status, available_at);

CREATE INDEX IF NOT EXISTS lookups_identifier
  ON qms.lookups (identifier_type, identifier_value, created_at DESC);

CREATE INDEX IF NOT EXISTS events_action
  ON qms.events (action, id DESC);

DELETE FROM qms.rate_limits;
ALTER TABLE qms.rate_limits DROP CONSTRAINT IF EXISTS rate_limits_pkey;
ALTER TABLE qms.rate_limits ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);
