# SAMANA QMS

Customer QR check-in, staff-issued tickets, executive workstations, HOD/manager operations and reception TVs. Three services: a Next.js web tier that serves the screens and holds no credential, a private API service that hosts the route table with Prisma as the typed data layer over PostgreSQL (any server; Neon hosted it during the review), and a scheduler. Salesforce is reached only from the API and the scheduler. Official SAMANA Ocean Pearl, Ocean Bay, and Rome imagery and logos are bundled locally; provenance is in `public/images/sources.json` and `public/images/redesign-sources.json`. Manrope and Cormorant Garamond fonts are self-hosted with their OFL licenses.

## Current delivery

The QMS database is `samana_qms`; automated database tests use the separate `samana_qms_test` database. The existing unrelated database was not altered. Salesforce authentication and account/unit/project lookups have been verified against the supplied POD2 sandbox. The approved ticket API patch was deployed to POD2 on 21 September 2026 with all nine Apex tests passing. See the [security review](docs/security-review-2026-09-21.md).

The implementation includes the BRD's 21 functional requirements, subject to the operational setup below. The user's instruction replaces the documents' kiosk hardware flow with rotating reception/TV QR codes and customer mobiles. Staff can also issue tickets. See [requirements and decisions](docs/requirements.md).

**Launch setup still required:** complete staff/service mappings, configure an SMS gateway, and complete visual/device, backup restore, and capacity acceptance testing. Render is the management review host; verify both web and scheduler deployment settings in [Render setup](docs/render.md). Salesforce ticket writeback is approved for POD2 and enabled in its Render Blueprint. The supplied Salesforce endpoint is a sandbox, not a production organization.

## Start locally

Node.js 22.13+ and npm are required. The local `.env` already contains the supplied connection settings and a generated initial administrator password. It is ignored by Git. For another installation, copy `.env.example` to `.env` and configure it.

```sh
npm ci                    # also generates the Prisma client (postinstall)
npm run db:migrate
npm run db:bootstrap
npm run build:api
npm run api               # the API service on API_PORT (default 3001)
```

In a second terminal the scheduler, and in a third the web tier:

```sh
npm run build:worker && npm run worker
npm run dev               # forwards /api to API_URL from .env
```

Open the exact URL printed by the web server. Set `APP_ORIGIN` to that origin and `API_URL` to where the API listens (`http://127.0.0.1:3001` locally). The session cookie's Secure flag must agree with the origin's scheme: a local `http://` setup needs `SESSION_COOKIE_SECURE=false`, and an `https://` deployment uses `true` (the default). Every setting is validated once at start (`lib/config.ts`); a wrong or missing value stops the server with a message naming the variable, and `.env.example` documents each rule. No credentials are embedded in browser code.

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
4. Build and start: `npm run build`, `npm run build:api`, `npm run build:worker`, then `npm run api`, `npm start` and `npm run worker` in three terminals, or `docker compose up -d`.

Moving data from one server to another is one `pg_dump` of `samana_qms` and one restore; the migration ledger travels with it.

## Features

- Mobile, Emirates ID, and passport lookup; English/Arabic check-in; first matching Salesforce account; single-unit automatic selection.
- Registered CRM services: General Query, NOC/Resale, Refund, Handover. Collection selects Collections. Unknown customers get General Query.
- Atomic ticket numbering, idempotent issuance, duplicate active-visit prevention, preferred owner routing, strict greater-than-five-minute escalation, and visible unmapped/offline exceptions.
- Fair turns across counters: one rotation per person, so a customer taken in any service moves them to the back of every queue they cover. Nobody is given a second customer while they still hold one, and closing a visit offers them the next one immediately.
- Per-service urgency (Queues screen, 0 normal to 9 urgent): a waiting customer in a higher-urgency service is routed before an older one elsewhere, while arrival order still decides inside a service.
- Call, start, complete with notes, no-show, manager reassignment, notifications, printable receipts, and TV announcements. A customer's private link shows their service's board — the ten tickets ahead of them, their own and the four behind — with ticket numbers and states only, the same information the reception television already shows the waiting room.
- Live queue filtering, pagination, operational metrics, team administration, connection health, audit history, reports, and spreadsheet-safe CSV exports.
- Interactive table/board views, removable filter chips, live department summaries, keyboard quick actions (Ctrl/Cmd+K), mobile navigation, and a focused ticket drawer with visit progress and pinned actions. The board displays the current page of results; use pagination to see further tickets.
- Service selection cards, English/Arabic check-in labels, report date presets, password visibility controls, reduced-motion support, and a consistent SAMANA visual system across staff, customer, and TV screens. Report charts load on demand.
- Durable routing, worker health, retryable integration outbox, lease ownership, session revocation on password reset, role checks, request-size limits, and rate limiting.

## Production build and self-hosting

**Deploying to a new environment?** `deploy/README.md` is the handover
specification: the three processes and what each one needs, per-tier
environment templates, database provisioning, release order and the
verification checklist. It is host-agnostic — start there, then use
`render.yaml` or `compose.yaml` as a worked example of it.


```sh
npm run build             # Web tier: standalone Node server in dist-node/standalone (build:node is an alias)
npm run build:api         # API service in dist-api/api.mjs (regenerates the Prisma client first)
npm run build:worker      # Scheduler in dist-worker/worker.mjs
node --env-file=.env dist-api/api.mjs
node --env-file=.env dist-node/standalone/server.js
```

The build runs in place and writes `.next`; the script validates the destination before replacing only the generated `dist-node` directory. Next.js keeps `next dev` output separately under `.next/dev`, so a running development server is unaffected. Keep the source workspace on a normal local disk if OneDrive sync locking affects development.

Docker Compose defines three unprivileged services on one private network: `web` publishes port 3000 and receives only `APP_ORIGIN` and `API_URL`; `api` is reachable only from the other containers and holds the credentials; `scheduler` runs the tick. Only the web tier is exposed, so the database and Salesforce credentials never sit on an internet-facing process. Docker was not installed in this workstation, so the Node artifacts were built and exercised here but the container build still needs execution on the deployment host.

```sh
docker compose build
docker compose run --rm scheduler node scripts/migrate.mjs
docker compose run --rm scheduler node scripts/bootstrap.mjs
docker compose up -d
```

Configure `.env` on the server with an HTTPS `APP_ORIGIN`, `SESSION_COOKIE_SECURE=true`, strong independent `QR_SIGNING_SECRET` and `WORKER_SECRET`, and the PostgreSQL connection string (`?sslmode=verify-full` for a TLS host). Put a TLS reverse proxy in front of web's loopback port 3000; the API never needs a public address. The web tier forwards the client address its edge appended as `x-client-address`, and the API is configured to trust that header alone (`TRUSTED_CLIENT_IP_HEADER=x-client-address`). Secrets are omitted from the image context.

Connect the app as the restricted `qms_app` role created by `npm run db:app-role`, and keep the owner connection string in `MIGRATE_DATABASE_URL` for migrations. `RETENTION_IDENTIFIER_DAYS` and `RETENTION_EVENT_DAYS` switch on anonymisation of closed tickets and purging of old audit events once a retention period is agreed. `GET /api/health/alerts` is the one address an uptime monitor should page on. Tickets left waiting from a previous day are marked no-show two hours after issue, and a number still on the floor from yesterday is never reissued today.

The web tier is a standard Next.js standalone server and the API is a plain Node HTTP server (`server/api.ts`), so any Node host works; Render is the reference deployment in `render.yaml`, with the API as a private service. The scheduler runs as a direct database worker everywhere (Docker, Render, `npm run worker`): routing tick, outbox delivery and retention every 15 seconds. `POST /api/jobs/run` with `Authorization: Bearer WORKER_SECRET` remains for hosts that can only run a cron-style caller. Live screen updates use server-sent events fed by PostgreSQL `NOTIFY`; a host that buffers streaming responses degrades gracefully to polling. The listener needs one session that stays on a real server connection: on Neon it uses the direct endpoint even when `DATABASE_URL` is the pooled one, and behind a PgBouncer in transaction mode that one connection must bypass the pooler.

## SMS and Salesforce write-back

SMS is disabled until the gateway is configured. Set `SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN`, `SMS_SENDER`, and `SMS_ENABLED=true` only after validating the provider contract in [integrations](docs/integrations.md). The gateway must support idempotency. EID/passport check-ins never create SMS jobs, even when Salesforce contains a phone number. Queue operation continues if messaging fails; staff see delivery status.

POD2 ticket writeback and the two-class Apex fix were explicitly approved. Its Render Blueprint sets `SALESFORCE_WRITE_ENABLED=true`; verify the value on an existing manually configured service. Other orgs retain the disabled `.env.example` default until approved and validated. The adapter uses a stable external ticket key and full snapshots, and marks delivery complete only after Salesforce confirms a record ID.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm audit --audit-level=high
```

Full tests require a PostgreSQL database named exactly `samana_qms_test`, on any server. Put its URL and synthetic QR/origin settings in ignored `.env.test`, then migrate it using `node --env-file=.env.test scripts/migrate.mjs`. Tests refuse another database name. Salesforce is mocked in API tests; live read-only verification is separate. The suite has two projects: `server` (domain, API, database, delivery, security, configuration and browser-policy suites in Node) and `browser` (component tests for the check-in screen and the live queue table in a DOM, `tests/ui/`). `npm run test:coverage` runs both and fails when coverage drops below the thresholds in `vitest.config.ts`. Unit tests can run without a database: `npx vitest run tests/domain.test.ts tests/apex-only.test.ts tests/scheduler.test.ts tests/events.test.ts tests/routes.test.ts tests/openapi.test.ts`. Applied migrations are checksummed; editing one after it has run is refused by `scripts/migrate.mjs`, so always add a new file. `npm run api:docs` regenerates `docs/openapi.json` from the route table; a test fails when it is stale.

CI checks types, lint, the unit and browser tests, dependency audit and both builds. The database job starts a PostgreSQL 18 container inside the workflow, migrates it and runs the full suite with coverage thresholds, so no external database or secret is needed. Device acceptance remains pending because no real phones, printer or TV were connected during implementation. Test real mobile QR scanning, Arabic layout, desktop notifications, printing, TV fullscreen/audio, and reconnect behavior before launch.

## Operations

See [operations](docs/operations.md) for schema ownership, monitoring, recovery, retention, and release procedure. The data layer is `prisma/schema.prisma`, introspected from the database and pinned by a test, with the generated client for records and typed, row-validated calls into the PostgreSQL functions that hold the queue rules (`lib/data/`). The browser never talks to PostgreSQL, Salesforce or the API service directly; everything goes through the web tier. No sample customer records are seeded into the app database.
