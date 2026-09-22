# Rolling back

The migration runner is forward-only by design: it records a checksum of every
applied file and refuses to run one that has been edited, so the history of a
database is always the history of these files. That gives no automatic "down"
step, which is a deliberate trade and not an oversight — a down migration that
has never been run is a script that does not work, and discovering that during
an incident is worse than having none.

What follows is the procedure that replaces it. Read the whole of the relevant
section before starting.

## Before any deployment that migrates

Take a snapshot. On Neon the point-in-time window is **six hours**, which is
shorter than the time it usually takes for a data problem to be noticed, so the
snapshot is the real restore point:

```
# Neon console → Branches → production → Snapshots → Create snapshot
# or, for any PostgreSQL server:
pg_dump "$MIGRATE_DATABASE_URL" -Fc -f pre-migration-$(date +%Y%m%d-%H%M).dump
```

Name it after the migration it precedes. Record the name in the deployment
notes; a snapshot nobody can find is not a restore point either.

## Choosing between forward-fix and restore

Restoring loses every visit recorded since the snapshot, so it is the last
option, not the first.

| Situation | Do this |
|---|---|
| The schema applied but the application misbehaves | Roll back the **application** (Render → previous deploy). Every migration here is written so the previous version of the code still runs against the new schema. |
| A migration added something and you want it gone | Apply the reverse script below, then a new migration that removes it properly. |
| A migration destroyed or corrupted data | Restore the snapshot. Nothing else recovers it. |

The middle column matters and is easy to miss: because each migration keeps the
signatures the previous code calls, **rolling back the application alone is
almost always the right first move**, and it takes a minute.

## Reverse scripts

These are written out rather than run automatically. Check what the migration
did first (`db/0NN_*.sql`), then apply as the owner
(`MIGRATE_DATABASE_URL`), then add a new numbered migration recording the
change so the files and the database stay in step.

### 018_read_path_indexes.sql — fully reversible

Indexes only; no data is touched. Dropping them restores the old plans and
nothing else.

```sql
DROP INDEX IF EXISTS qms.tickets_active;
DROP INDEX IF EXISTS qms.tickets_number_trgm;
DROP INDEX IF EXISTS qms.tickets_customer_name_trgm;
DROP INDEX IF EXISTS qms.tickets_unit_name_trgm;
-- pg_trgm is left installed: dropping an extension other objects may use is
-- not something to do during an incident.
```

### 017_fair_routing_and_priority.sql — reversible except one table

The functions can be restored by re-running the versions in the migrations that
preceded them (005, 008, 012, 014, 015). The columns can be dropped. What
cannot be recreated from the database alone is `qms.round_robin`, which 017
dropped after carrying its cursors onto `qms.users.rotation`.

That matters less than it reads. The table held one row per person per service
recording *whose turn it was* — a fairness cursor, not a record of anything
that happened. Losing it reorders one rotation once. Every ticket, event and
audit row is untouched.

```sql
-- Structure only; the cursors themselves are in qms.users.rotation.
CREATE TABLE IF NOT EXISTS qms.round_robin (
  service_id text NOT NULL REFERENCES qms.services(id),
  user_id uuid NOT NULL REFERENCES qms.users(id),
  last_assigned timestamptz NOT NULL DEFAULT now(),
  position bigint NOT NULL DEFAULT nextval('qms.rotation_position'),
  PRIMARY KEY (service_id, user_id)
);
INSERT INTO qms.round_robin(service_id, user_id, position)
SELECT s.id, u.id, u.rotation FROM qms.users u CROSS JOIN qms.services s
 WHERE s.id = ANY(u.services)
ON CONFLICT DO NOTHING;
ALTER SEQUENCE IF EXISTS qms.rotation_position RENAME TO round_robin_position;
ALTER TABLE qms.services DROP CONSTRAINT IF EXISTS services_priority_range;
ALTER TABLE qms.services DROP COLUMN IF EXISTS priority;
ALTER TABLE qms.users DROP COLUMN IF EXISTS rotation;
```

Then re-run the function bodies from `db/015_presence_window.sql` (routing and
availability) and `db/014_rollover_retention_and_numbers.sql`
(`route_due`, `issue_ticket`), and drop what 017 introduced:

```sql
DROP FUNCTION IF EXISTS qms.offer_next(uuid);
DROP FUNCTION IF EXISTS qms.route_waiting(integer, integer);
DROP FUNCTION IF EXISTS qms.route_maintenance();
DROP FUNCTION IF EXISTS qms.note_worker_run(integer);
DROP FUNCTION IF EXISTS qms.set_service_priority(text, integer, uuid);
DROP FUNCTION IF EXISTS qms.presence_window();
DROP FUNCTION IF EXISTS qms.serving_roles();
DROP FUNCTION IF EXISTS qms.manager_roles();
```

A reverse of 017 must also roll the application back, because the current code
reads `qms.users.rotation` and calls `qms.route_waiting`.

## After any rollback

1. `node --env-file=.env scripts/migrate.mjs` — confirm the ledger matches.
2. `npm run db:schema` against the test database and check `db/schema.sql` is
   unchanged, or commit the difference.
3. `curl -fsS https://<host>/api/health/alerts` — expect `200 {"status":"ready"}`.
4. Watch `/api/health/scheduler` for one tick (15 s) to confirm routing resumed.
