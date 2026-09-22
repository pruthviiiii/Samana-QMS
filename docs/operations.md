# Operations and release guide

## Database and privileges

App data is isolated in the `qms` schema of the `samana_qms` database on whichever PostgreSQL server `DATABASE_URL` points at (14 or newer; Neon hosted it during the review, a company server or a managed service works the same). Tests use `samana_qms_test`. The API service and the scheduler connect as the restricted role `qms_app`, which can read and write the `qms` tables and run its functions and nothing else; the web tier has no database connection at all; migrations run as the schema owner through `MIGRATE_DATABASE_URL`. `npm run db:app-role` (`scripts/create-app-role.mjs`) creates the role in the database the owner string points at, or refreshes its grants, and prints the `DATABASE_URL` to use. Run it once per database. PostgreSQL roles are server-wide, so the second run only adds the grants for that database. Moving to another server is one `pg_dump` and restore of `samana_qms`; the migration ledger travels with the data. Do not publish connection strings or add `.env`, `.dev.vars`, `.analysis`, `.sf`, or generated artifacts to source control.

`db/001_...sql` through later migrations define schema and transactional operations. Applied filenames and a checksum of their content are recorded in `qms.migrations`; `scripts/migrate.mjs` refuses to start when an applied file has been edited, so always add a new migration. `db/schema.sql` is the generated snapshot of the current schema (`npm run db:schema`) and a test fails when it drifts. `prisma/schema.prisma` is the second description of the same database, introspected with `npm run prisma:pull`, and its own test fails when it drifts; the Prisma client generated from it (`npm ci` or `npm run prisma:generate`) types every record read and write in `lib/data/`. The queue engine's functions are called through typed wrappers whose results are validated row by row (`lib/data/functions.ts`, `lib/data/rows.ts`). Prisma does not run migrations here: its schema language cannot express the functions, triggers and partial indexes the engine depends on, so the numbered SQL files stay the single source of truth. Ticket actions, issuance, queue membership and the routing sweep serialize on one transaction advisory lock, which favours predictable consistency for one reception deployment. Two things bound what that costs. The sweep routes in batches of 25 and takes the lock once per batch (`routeDue` in `lib/data/functions.ts`), so an agent pressing Call waits for one batch rather than the whole queue; `qms.route_due()` still does the same work in a single transaction and exists for tests and for the comparison in `scripts/load-check.mjs`. Presence heartbeats, which every signed-in agent sends every 15 seconds, do not take the lock at all: `qms.set_presence` locks only the account row it writes. Measured on one local PostgreSQL 18 with 400 waiting tickets and 20 agents (`node --env-file=.env.test scripts/load-check.mjs 20 400 20`, after `ANALYZE`), the wait for the lock during a sweep was p50 18 ms / max 53 ms batched against p50 252 ms / max 252 ms in one transaction: an agent pressing Call waits for one batch instead of the whole queue. Batching costs about 45% more total sweep time (365 ms against 253 ms) for the extra round trips, which is the intended trade — the sweep runs on a 15-second timer with nobody waiting on it, while the agent is a person standing at a counter. Run `ANALYZE` after restoring or rebuilding a database before reading these numbers: on a database with no statistics the same sweep measured four times slower. These are one machine and one run, not a throughput guarantee; re-run them for the expected branch and agent count before wider rollout.

## Monitoring and failure handling

- Point the uptime monitor at `/api/health/alerts`. It is 503, with a `problems` list, while the scheduler heartbeat is older than 90 seconds, any outbox delivery has given up (`failed`), or the Salesforce circuit breaker has paused lookups. `/api/health` is database readiness only (Render's health check) and `/api/health/scheduler` is the heartbeat alone.
- Settings shows Salesforce/database/SMS/scheduler health. Staff queue shows the stale-scheduler state. Authentication, Salesforce outages, missing unit data, and no available agents have explicit error/exception states.
- Monitor `qms.outbox` failed/disabled jobs. Outbox leases prevent a stale worker from overwriting a newer worker's result. Upstream idempotency is required for external delivery. An abandoned final delivery attempt is marked failed for review.
- Screens refresh on server-sent events from `/api/events`, fed by `NOTIFY` triggers (migration 013), and poll as a fallback. The web process holds one `LISTEN` session on a real server connection (on Neon the direct endpoint, never a transaction-mode pooler); while it is down the queue badge shows "Auto-refresh" instead of "Live updates" and screens poll every 5 seconds. If an issue-ticket response is lost, retry with the same requestId; do not generate another ID. Optimistic ticket versions protect manager/agent races.
- Every API response carries `X-Request-Id`, and the API service's log has one JSON line per request (`event: request`) with method, masked path, status and duration. Quote the request id when investigating a report. The web tier only forwards `/api`; a `503 API_NOT_CONFIGURED` from it means the web tier has no `API_URL`, and a 502 means the API service is down.
- Per-address rate limits use the header named by `TRUSTED_CLIENT_IP_HEADER`. Behind the web tier that is `x-client-address`, which the web tier sets from the address its own edge appended and which a client cannot forge because the web tier always overwrites it; the shared per-account and global limits apply regardless.
- Never mark SMS sent by editing the database. After reviewing a failed job with the provider, an administrator can reset its attempts/status/available_at using an audited operational SQL change. The UI currently provides status, not an unrestricted delivery replay button.
- Logout always revokes the session. A called/in-service ticket remains assigned for explicit completion or manager handling; heartbeat expiry detects browser/network loss. The separate go-offline action still prevents abandoning active service.

## Day rollover

The reads that grow with the visit history are index-backed and measured.
`qms.statistics` and `qms.serviceCounts` run on every staff screen refresh and
once scanned the whole ticket table; migration 018 gives them a partial index
over the active statuses and the queries say which rows they need, and queue
search moved off a sequential scan onto trigram indexes. Measured on a local
PostgreSQL 18 at 200,000 tickets (`node --env-file=.env.test
scripts/read-path-check.mjs`): dashboard statistics 232 ms to 2.4 ms, service
counts 215 ms to 0.2 ms. Re-run that script after touching either query; a
sequential scan in its AFTER rows is a regression. Rolling a migration back is
`docs/rollback.md`.

Ticket numbers restart every Dubai day. A ticket still waiting or called from a previous day is marked no-show by the routing tick once it is more than two hours old, with an audited `day_rollover` reason, so it leaves the queue and the TV; a ticket being served is left to its agent. When a number from a previous day is still on the floor, today's numbering skips it, so two live tickets never share a number.

## Backups, retention, recovery

Use the host's backup and point-in-time recovery: on your own server, nightly `pg_dump` plus WAL archiving (or the platform's backups); on Neon, the project's recovery window and branches. To rehearse a restore, restore a backup into a separate database (on Neon, a branch from a past timestamp), run `node scripts/migrate.mjs` against it, check the queue state and audit history, then drop it. Do not restore over an active production database as a first recovery step.

Sessions and rate-limit buckets expire and are cleaned by routing ticks. The same tick removes lookup snapshots that expired more than a day ago and are not attached to a ticket, and QR guest accounts older than a day that never issued a ticket.

Retention of ticket identifiers and audit events is a policy switch, off until a period is agreed. `RETENTION_IDENTIFIER_DAYS` anonymises the customer's name, mobile, Emirates ID and passport on tickets closed longer ago than that, and redacts the lookup snapshot behind them once no newer ticket refers to it; unit, project, booking number and Salesforce ids stay for reporting. `RETENTION_EVENT_DAYS` deletes older audit events. The scheduler tick applies the policy at most once an hour (`qms.apply_retention`), records the counts in `qms.system_state` and writes a `retention` audit event when anything changed. Restrict backup/report access because reports include personal identifiers until then. On Render the two settings are declared independently on `samana-qms-api` and `samana-qms-scheduler` (a Blueprint sync bug refuses to link an intentionally empty value between services), so setting a period means updating both service's environment in the dashboard, not just `render.yaml`.

The audit trail records sign-ins, failed sign-ins, sign-outs and every change of staff availability (including heartbeat expiry) alongside ticket, team, queue and reporting events. The Activity log screen filters by date and action and pages through history; every API response also carries an `X-Request-Id` that appears in the server log line for that request.

## Release and rollback

1. Back up and verify the intended database identity. Run types/lint/tests/audit and the three production builds (`build`, `build:api`, `build:worker`).
2. Apply new migrations using the migration credential. Test database migrations before app database migrations.
3. Deploy the API service first (its pre-deploy step runs the migrations), then the web tier and the scheduler, all from the same version. After a migration that changes a table, refresh `prisma/schema.prisma` with `npm run prisma:pull` before the release; the test suite fails until you do.
4. Verify web/database health, scheduler heartbeat, Salesforce read lookup, staff login, queue actions, QR/mobile access, and TV behavior.
5. Roll back the web/worker artifact to the preceding compatible version if needed. Do not blindly roll back schema or delete ticket history; prepare a reviewed forward-fix migration if a schema defect exists.

## Operational setup not yet completed

The current Salesforce connection targets POD2 sandbox. Production org selection and permissions, SMS provider, staff passwords and queue assignments, public customer access, a persistent scheduler host, visual/device acceptance, container execution, capacity testing, and backup restore verification remain launch work. A local worker process is suitable for review while the terminal session is running; it is not a production service manager.
