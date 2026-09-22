-- 018: make the three reads that grow with history index-backed.
--
-- Every one of these was a sequential scan of qms.tickets. That is free today
-- and linear in the whole visit history at a year's volume, which is the shape
-- of problem that is invisible in testing and arrives all at once.
--
-- 1. The queue dashboard (qms.statistics, qms.serviceCounts in lib/data/
--    tickets.ts) counts waiting and serving tickets. Those are current-state
--    numbers, so a partial index over the active statuses answers them from a
--    few rows however long the history is.
--
-- 2. The same dashboard's "completed today" and "average wait today" are
--    scoped to one Dubai day, which the existing (day, service_id, sequence)
--    unique index already serves once the query says so.
--
-- 3. Queue search matches a substring of a ticket number, customer name or
--    unit. A leading wildcard cannot use a btree index at all, so this was a
--    full scan on every keystroke that reached the server. Trigram indexes are
--    the standard answer and turn it into an index scan for any term of three
--    characters or more.

-- Active tickets: the working set, whatever the archive holds.
CREATE INDEX IF NOT EXISTS tickets_active
  ON qms.tickets (status)
  WHERE status IN ('waiting', 'called', 'serving');

-- Substring search over the three columns the queue screen searches.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS tickets_number_trgm
  ON qms.tickets USING gin (number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tickets_customer_name_trgm
  ON qms.tickets USING gin (customer_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tickets_unit_name_trgm
  ON qms.tickets USING gin (unit_name gin_trgm_ops);

-- The planner needs current statistics to choose the indexes above. A restored
-- or freshly migrated database has none, and the same sweep measured four times
-- slower until it did; see docs/operations.md.
ANALYZE qms.tickets;
