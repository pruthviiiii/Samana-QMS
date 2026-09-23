-- =============================================================================
--  Samana QMS — production database provisioning
-- =============================================================================
--
--  Equivalent to `node scripts/create-app-role.mjs`, written as plain SQL for a
--  DBA who will not run Node. Use one or the other, not both.
--
--  READ THIS BEFORE RUNNING
--
--  The steps are in three parts and THE ORDER MATTERS. Part B creates the
--  schema by running the application's migrations; Part C grants rights on the
--  objects Part B created. Running Part C first grants nothing, silently,
--  because there is nothing yet to grant on.
--
--    Part A   as a superuser        create the database, the roles, extensions
--    Part B   as qms_owner          run the migrations  (NOT SQL — see below)
--    Part C   as qms_owner          grant the runtime role its rights
--
--  Two roles exist on purpose:
--    qms_owner   owns the schema and may change it. Migrations only.
--    qms_app     the three application processes. Reads and writes rows and
--                executes functions. NO schema changes — so a compromised
--                application process cannot drop a table.
--
--  Replace every CHANGE_ME before running. Use distinct, generated passwords:
--    node -e "console.log(crypto.randomBytes(24).toString('base64url'))"
--
-- =============================================================================


-- =============================================================================
--  PART A — as a superuser, connected to the maintenance database (postgres)
-- =============================================================================

CREATE ROLE qms_owner LOGIN PASSWORD 'CHANGE_ME_OWNER';
CREATE ROLE qms_app   LOGIN PASSWORD 'CHANGE_ME_APP';

CREATE DATABASE samana_qms OWNER qms_owner;

REVOKE ALL ON DATABASE samana_qms FROM PUBLIC;
GRANT CONNECT ON DATABASE samana_qms TO qms_app;

-- Now reconnect to samana_qms itself before continuing:  \c samana_qms

-- Migration 018 creates the pg_trgm extension for customer search. The owner
-- can usually do this itself. On a managed host where extension creation needs
-- elevated rights, create it here as the superuser — otherwise migration 018
-- fails with "permission denied to create extension".
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- =============================================================================
--  PART B — run the migrations.  THIS IS NOT SQL.
-- =============================================================================
--
--  From a machine with the repository and Node 22+:
--
--    MIGRATE_DATABASE_URL="postgresql://qms_owner:...@HOST:5432/samana_qms?sslmode=verify-full" \
--      node scripts/migrate.mjs
--
--  It applies db/001_*.sql through db/018_*.sql in order, each inside its own
--  transaction, recording a checksum of every file. It is idempotent: running
--  it twice is safe, and it refuses to run a migration that was edited after it
--  was applied.
--
--  Do not create the tables by hand. The generated snapshot db/schema.sql is a
--  description of the result, not a script to run — a test compares the two,
--  and a hand-built schema will diverge from the migration ledger.
--
--  WAIT FOR THIS TO FINISH before Part C.
--
-- =============================================================================


-- =============================================================================
--  PART C — as qms_owner, connected to samana_qms, AFTER migrations
-- =============================================================================

GRANT USAGE ON SCHEMA qms TO qms_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA qms TO qms_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA qms TO qms_app;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA qms TO qms_app;

-- Objects a LATER migration creates are covered too, so this does not have to
-- be re-run after every release.
ALTER DEFAULT PRIVILEGES FOR ROLE qms_owner IN SCHEMA qms
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qms_owner IN SCHEMA qms
  GRANT USAGE, SELECT ON SEQUENCES TO qms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qms_owner IN SCHEMA qms
  GRANT EXECUTE ON FUNCTIONS TO qms_app;

-- Planner statistics. Without these the queue sweep measured four times slower
-- and the read-path indexes were ignored entirely. Required after the first
-- migration and after any restore.
ANALYZE;


-- =============================================================================
--  VERIFICATION — as qms_app, using the runtime connection string
-- =============================================================================
--
--  1. The schema is complete: 18 migrations recorded.
--        SELECT count(*) FROM qms.migrations;                  -- expect 18
--
--  2. The six services exist.
--        SELECT id, name, department, priority FROM qms.services ORDER BY id;
--
--  3. The runtime role can read, write and execute.
--        SELECT qms.presence_window();                         -- expect 45 s
--
--  4. The runtime role CANNOT change the schema. This must FAIL with
--     "permission denied". If it succeeds, qms_app has more rights than it
--     should and the separation is not in place.
--        CREATE TABLE qms.should_not_work (id int);
--
-- =============================================================================
--  CONNECTION STRINGS
-- =============================================================================
--
--    Runtime      (web / api / scheduler — DATABASE_URL)
--      postgresql://qms_app:PASSWORD@HOST:5432/samana_qms?sslmode=verify-full
--
--    Migrations   (MIGRATE_DATABASE_URL)
--      postgresql://qms_owner:PASSWORD@HOST:5432/samana_qms?sslmode=verify-full
--
--  Keep ?sslmode=verify-full for any managed or remote server. Omit it only for
--  a local server with no TLS.
--
--  Sizing: each API instance opens up to 10 pooled connections plus one
--  dedicated session that holds LISTEN qms_changes for live screen updates.
--  Allow (api_instances x 11) + 2 for the scheduler and migrations.
--
--  If a connection pooler sits in front of this database, that one LISTEN
--  session must use session mode or bypass the pooler. In transaction mode the
--  command is accepted and notifications are never delivered — screens keep
--  working but fall back to polling instead of updating immediately.
-- =============================================================================
