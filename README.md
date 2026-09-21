# SAMANA QMS

React application for customer QR check-in, staff-issued tickets, executive workstations, HOD/manager operations, and reception TVs. Built with TypeScript, Next.js, PostgreSQL (any server; Neon hosted it during the review), and server-side Salesforce APIs. Official SAMANA Ocean Pearl, Ocean Bay, and Rome imagery and logos are bundled locally; provenance is in `public/images/sources.json` and `public/images/redesign-sources.json`. Manrope and Cormorant Garamond fonts are self-hosted with their OFL licenses.

## Current delivery

The QMS database is `samana_qms`; automated database tests use the separate `samana_qms_test` database. The existing unrelated database was not altered. Salesforce authentication and account/unit/project lookups have been verified against the supplied POD2 sandbox. The approved ticket API patch was deployed to POD2 on 21 September 2026 with all nine Apex tests passing. See the [security review](docs/security-review-2026-09-21.md).

The implementation includes the BRD's 21 functional requirements, subject to the operational setup below. The user's instruction replaces the documents' kiosk hardware flow with rotating reception/TV QR codes and customer mobiles. Staff can also issue tickets. See [requirements and decisions](docs/requirements.md).

**Launch setup still required:** complete staff/service mappings, configure an SMS gateway, and complete visual/device, backup restore, and capacity acceptance testing. Render is the management review host; verify both web and scheduler deployment settings in [Render setup](docs/render.md). Salesforce ticket writeback is approved for POD2 and enabled in its Render Blueprint. The supplied Salesforce endpoint is a sandbox, not a production organization.

## Start locally

Node.js 22.13+ and npm are required. The local `.env` already contains the supplied connection settings and a generated initial administrator password. It is ignored by Git. For another installation, copy `.env.example` to `.env` and configure it.

```sh
npm ci
npm run db:migrate
npm run db:bootstrap
npm run build:worker
npm run worker
```

In a second terminal:

```sh
npm run dev
```

Open the exact URL printed by the server. Set `APP_ORIGIN` to that origin. Local HTTP requires `SESSION_COOKIE_SECURE=false`; any HTTPS deployment must use `true`. No credentials are embedded in browser code.

Sign in using `BOOTSTRAP_USERNAME` (currently `admin`) and `BOOTSTRAP_PASSWORD` from the local `.env`. Change the temporary password when prompted. Bootstrap never overwrites an existing administrator. Remove the bootstrap password from a production host after provisioning.

1. In Team, add each staff member: search Salesforce by name or email, pick the person, then set role, queues, counter and a temporary password. Nothing is imported in bulk.
2. In Queues, put members into each service queue. Queues live in the app database only; nothing is read from or written to Salesforce groups.
3. Set staff passwords, roles, counters, and enabled status. Members change temporary passwords at first sign-in. Staff go online to receive tickets. Collection managers must be mapped to the correct Salesforce user IDs.
4. Create a dedicated `display` account for each TV. Sign in, open TV Display, enter fullscreen, and enable speech announcements if desired. Browser audio requires a user gesture. Display accounts cannot retrieve customer records or reports. Sessions last eight hours; re-authenticate at shift start.
5. Show the rotating QR on the TV or reception's Check-in QR dialog. Invite links expire after five minutes; the display refreshes them every two minutes. Customer sessions last 45 minutes. Customers must scan a fresh QR for a new session.

Localhost QR codes work only on the same computer. Customers' phones require an approved, reachable HTTPS domain such as the Render deployment.

## Your own PostgreSQL server

The app talks standard PostgreSQL (14 or newer) over the normal wire protocol; nothing depends on a particular host. To run it against your own server:

1. Create the database and an owner role, for example as the `postgres` superuser:
   ```sql
   CREATE ROLE qms_owner LOGIN PASSWORD '<owner password>' CREATEROLE;
   CREATE DATABASE samana_qms OWNER qms_owner;
   ```
   Repeat with `samana_qms_test` if you want to run the test suite there.
2. Put the owner string in `.env` as `DATABASE_URL` (`postgresql://qms_owner:<password>@<host>:5432/samana_qms`; add `?sslmode=verify-full` only when the server uses TLS) and run `npm run db:migrate` and `npm run db:bootstrap`.
3. Run `npm run db:app-role`. It creates the restricted `qms_app` role and prints the string to use as `DATABASE_URL`; move the owner string to `MIGRATE_DATABASE_URL`.
4. Build and start: `npm run build`, `npm run build:worker`, then `npm start` and `npm run worker` in two terminals, or `docker compose up -d`.

Moving data from one server to another is one `pg_dump` of `samana_qms` and one restore; the migration ledger travels with it.

## Features

- Mobile, Emirates ID, and passport lookup; English/Arabic check-in; first matching Salesforce account; single-unit automatic selection.
- Registered CRM services: General Query, NOC/Resale, Refund, Handover. Collection selects Collections. Unknown customers get General Query.
- Atomic ticket numbering, idempotent issuance, duplicate active-visit prevention, preferred owner routing, service-specific round robin, strict greater-than-five-minute escalation, and visible unmapped/offline exceptions.
- Call, start, complete with notes, no-show, manager reassignment, notifications, printable receipts, private mobile ticket status, and TV announcements.
- Live queue filtering, pagination, operational metrics, team administration, connection health, audit history, reports, and spreadsheet-safe CSV exports.
- Interactive table/board views, removable filter chips, live department summaries, keyboard quick actions (Ctrl/Cmd+K), mobile navigation, and a focused ticket drawer with visit progress and pinned actions. The board displays the current page of results; use pagination to see further tickets.
- Service selection cards, English/Arabic check-in labels, report date presets, password visibility controls, reduced-motion support, and a consistent SAMANA visual system across staff, customer, and TV screens. Report charts load on demand.
- Durable routing, worker health, retryable integration outbox, lease ownership, session revocation on password reset, role checks, request-size limits, and rate limiting.

## Production build and self-hosting

```sh
npm run build             # Standalone Node server in dist-node/standalone (build:node is an alias)
npm run build:worker      # Independent 15-second scheduler
node --env-file=.env dist-node/standalone/server.js
```

The build runs in place and writes `.next`; the script validates the destination before replacing only the generated `dist-node` directory. Next.js keeps `next dev` output separately under `.next/dev`, so a running development server is unaffected. Keep the source workspace on a normal local disk if OneDrive sync locking affects development.

Docker Compose defines separate unprivileged web and scheduler services. Docker was not installed in this workstation, so the Node artifacts were built and exercised here but the container build still needs execution on the deployment host.

```sh
docker compose build
docker compose run --rm scheduler node scripts/migrate.mjs
docker compose run --rm scheduler node scripts/bootstrap.mjs
docker compose up -d
```

Configure `.env` on the server with an HTTPS `APP_ORIGIN`, `SESSION_COOKIE_SECURE=true`, strong independent `QR_SIGNING_SECRET` and `WORKER_SECRET`, and the PostgreSQL connection string (`?sslmode=verify-full` for a TLS host). Put a TLS reverse proxy in front of web's loopback port 3000. Do not expose the database credentials or scheduler bearer secret to clients. Secrets are omitted from the image context.

Connect the app as the restricted `qms_app` role created by `npm run db:app-role`, and keep the owner connection string in `MIGRATE_DATABASE_URL` for migrations. `RETENTION_IDENTIFIER_DAYS` and `RETENTION_EVENT_DAYS` switch on anonymisation of closed tickets and purging of old audit events once a retention period is agreed. `GET /api/health/alerts` is the one address an uptime monitor should page on. Tickets left waiting from a previous day are marked no-show two hours after issue, and a number still on the floor from yesterday is never reissued today.

The web app is a standard Next.js standalone server, so any Node host works; Render is the reference deployment in `render.yaml`. The scheduler either runs as a direct database worker (Docker, `npm run worker`) or, as on Render, calls `POST /api/jobs/run` every 15 seconds with `Authorization: Bearer WORKER_SECRET`. Live screen updates use server-sent events fed by PostgreSQL `NOTIFY`; a host that buffers streaming responses degrades gracefully to polling. The listener needs one session that stays on a real server connection: on Neon it uses the direct endpoint even when `DATABASE_URL` is the pooled one, and behind a PgBouncer in transaction mode that one connection must bypass the pooler.

## SMS and Salesforce write-back

SMS is disabled until the gateway is configured. Set `SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN`, `SMS_SENDER`, and `SMS_ENABLED=true` only after validating the provider contract in [integrations](docs/integrations.md). The gateway must support idempotency. EID/passport check-ins never create SMS jobs, even when Salesforce contains a phone number. Queue operation continues if messaging fails; staff see delivery status.

POD2 ticket writeback and the two-class Apex fix were explicitly approved. Its Render Blueprint sets `SALESFORCE_WRITE_ENABLED=true`; verify the value on an existing manually configured service. Other orgs retain the disabled `.env.example` default until approved and validated. The adapter uses a stable external ticket key and full snapshots, and marks delivery complete only after Salesforce confirms a record ID.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm audit --audit-level=high
```

Full tests require a PostgreSQL database named exactly `samana_qms_test`, on any server. Put its URL and synthetic QR/origin settings in ignored `.env.test`, then migrate it using `node --env-file=.env.test scripts/migrate.mjs`. Tests refuse another database name. Salesforce is mocked in API tests; live read-only verification is separate. Unit tests can run without a database: `npx vitest run tests/domain.test.ts tests/apex-only.test.ts tests/scheduler.test.ts tests/events.test.ts tests/routes.test.ts tests/openapi.test.ts`. Applied migrations are checksummed; editing one after it has run is refused by `scripts/migrate.mjs`, so always add a new file. `npm run api:docs` regenerates `docs/openapi.json` from the route table; a test fails when it is stale.

CI checks types, lint, unit tests, dependency audit and both builds. The database job starts a PostgreSQL 18 container inside the workflow, migrates it and runs the full suite, so no external database or secret is needed. Browser/device acceptance remains pending because no controllable browser was connected during implementation. Test real mobile QR scanning, Arabic layout, desktop notifications, printing, TV fullscreen/audio, and reconnect behavior before launch.

## Operations

See [operations](docs/operations.md) for schema ownership, monitoring, recovery, retention, and release procedure. Backend logic uses parameterized SQL and database transactions; the browser never talks directly to PostgreSQL or Salesforce. No sample customer records are seeded into the app database.
