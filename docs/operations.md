# Operations and release guide

## Database and privileges

App data is isolated in the `qms` schema of `samana_qms` on the connected Neon project. Tests use `samana_qms_test`. The current local connection is the supplied Neon owner role. Before production rollout, create a dedicated runtime role with only the app schema permissions required by the functions and tables; keep migrations under a separate owner credential. Do not publish connection strings or add `.env`, `.dev.vars`, `.analysis`, `.sf`, or generated artifacts to source control.

`db/001_...sql` through later migrations define schema and transactional operations. Applied filenames and a checksum of their content are recorded in `qms.migrations`; `scripts/migrate.mjs` refuses to start when an applied file has been edited, so always add a new migration. The live version of each database function is the last `CREATE OR REPLACE` in filename order. Database functions serialize routing/user-presence changes with a transaction advisory lock, which favors predictable consistency for one reception deployment. Load-test the expected branch/agent count before wider rollout; this is not a measured throughput guarantee.

## Monitoring and failure handling

- Monitor `/api/health` for web/database readiness and `qms.system_state` key `worker` for scheduler heartbeats (stale after 90 seconds).
- Settings shows Salesforce/database/SMS/scheduler health. Staff queue shows the stale-scheduler state. Authentication, Salesforce outages, missing unit data, and no available agents have explicit error/exception states.
- Monitor `qms.outbox` failed/disabled jobs. Outbox leases prevent a stale worker from overwriting a newer worker's result. Upstream idempotency is required for external delivery. An abandoned final delivery attempt is marked failed for review.
- Screens refresh on server-sent events from `/api/events`, fed by `NOTIFY` triggers (migration 013), and poll as a fallback. The web process holds one `LISTEN` session on Neon's direct endpoint; while it is down the queue badge shows "Auto-refresh" instead of "Live updates" and screens poll every 5 seconds. If an issue-ticket response is lost, retry with the same requestId; do not generate another ID. Optimistic ticket versions protect manager/agent races.
- Every API response carries `X-Request-Id`, and the web log has one JSON line per request (`event: request`) with method, masked path, status and duration. Quote the request id when investigating a report.
- Never mark SMS sent by editing the database. After reviewing a failed job with the provider, an administrator can reset its attempts/status/available_at using an audited operational SQL change. The UI currently provides status, not an unrestricted delivery replay button.
- Logout always revokes the session. A called/in-service ticket remains assigned for explicit completion or manager handling; heartbeat expiry detects browser/network loss. The separate go-offline action still prevents abandoning active service.

## Backups, retention, recovery

Use the Neon project's backup/PITR controls and choose a recovery window according to the organization's retention policy. Backup and restore have not been exercised in this workstation. Before launch, restore into a separate database/branch and verify migrations, queue state, session expiry, and audit history. Do not restore over an active production database as a first recovery step.

Sessions and rate-limit buckets expire and are cleaned by routing ticks. The same tick removes lookup snapshots that expired more than a day ago and are not attached to a ticket, and QR guest accounts older than a day that never issued a ticket. Tickets, their identifiers, notes and audit events are retained; no retention duration was supplied for them, so establish an approved retention/anonymization policy before production scale. Restrict backup/report access because reports include personal identifiers.

The audit trail records sign-ins, failed sign-ins, sign-outs and every change of staff availability (including heartbeat expiry) alongside ticket, team, queue and reporting events. The Activity log screen filters by date and action and pages through history; every API response also carries an `X-Request-Id` that appears in the server log line for that request.

## Release and rollback

1. Back up and verify the intended database identity. Run types/lint/tests/audit and both production builds.
2. Apply new migrations using the migration credential. Test database migrations before app database migrations.
3. Deploy the web app and restart the background worker using the same version and secrets.
4. Verify web/database health, scheduler heartbeat, Salesforce read lookup, staff login, queue actions, QR/mobile access, and TV behavior.
5. Roll back the web/worker artifact to the preceding compatible version if needed. Do not blindly roll back schema or delete ticket history; prepare a reviewed forward-fix migration if a schema defect exists.

## Operational setup not yet completed

The current Salesforce connection targets POD2 sandbox. Production org selection and permissions, SMS provider, staff passwords and queue assignments, public customer access, a persistent scheduler host, visual/device acceptance, container execution, capacity testing, and backup restore verification remain launch work. A local worker process is suitable for review while the terminal session is running; it is not a production service manager.
