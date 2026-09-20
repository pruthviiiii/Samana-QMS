# SAMANA QMS

React application for customer QR check-in, staff-issued tickets, executive workstations, HOD/manager operations, and reception TVs. Built with TypeScript, Vinext, Vite, PostgreSQL on Neon, and server-side Salesforce APIs. Official SAMANA Ocean Pearl, Ocean Bay, and Rome imagery and logos are bundled locally; provenance is in `public/images/sources.json` and `public/images/redesign-sources.json`. Manrope and Cormorant Garamond fonts are self-hosted with their OFL licenses.

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

1. In Team, sync the Salesforce directory. Imported users are disabled, have no password, and have no service access until configured.
2. In Settings, choose Salesforce queues/public groups for services and sync membership, or configure service membership individually in Team. Sync changes app data only. Nested public groups, queues, roles, subordinate roles, and organization groups are resolved. Unsupported dynamic group types produce an explicit error without changing memberships.
3. Set staff passwords, roles, counters, and enabled status. Members change temporary passwords at first sign-in. Staff go online to receive tickets. Collection managers must be mapped to the correct Salesforce user IDs.
4. Create a dedicated `display` account for each TV. Sign in, open TV Display, enter fullscreen, and enable speech announcements if desired. Browser audio requires a user gesture. Display accounts cannot retrieve customer records or reports. Sessions last eight hours; re-authenticate at shift start.
5. Show the rotating QR on the TV or reception's Check-in QR dialog. Invite links expire after five minutes; the display refreshes them every two minutes. Customer sessions last 45 minutes. Customers must scan a fresh QR for a new session.

Localhost QR codes work only on the same computer. Customers' phones require an approved, reachable HTTPS domain. The private Sites review link is owner-only and does not yet permit public customer check-in.

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
npm run build             # Cloudflare/Sites worker
npm run build:node        # Standalone Node server in dist-node/standalone
npm run build:worker      # Independent 15-second scheduler
node --env-file=.env dist-node/standalone/server.js
```

Windows builds stage a secret-free copy outside OneDrive to avoid its file locks. The build script validates the destination before replacing only the generated output directory. Keep the source workspace on a normal local disk if frequent sync locking affects development.

Docker Compose defines separate unprivileged web and scheduler services. Docker was not installed in this workstation, so the Node artifacts were built and exercised here but the container build still needs execution on the deployment host.

```sh
docker compose build
docker compose run --rm scheduler node scripts/migrate.mjs
docker compose run --rm scheduler node scripts/bootstrap.mjs
docker compose up -d
```

Configure `.env` on the server with an HTTPS `APP_ORIGIN`, `SESSION_COOKIE_SECURE=true`, strong independent `QR_SIGNING_SECRET` and `WORKER_SECRET`, and the Neon connection string. Put a TLS reverse proxy in front of web's loopback port 3000. Do not expose the database credentials or scheduler bearer secret to clients. Secrets are omitted from the image context.

For Sites, runtime secrets are managed in Sites and source metadata lives in `.openai/hosting.json`. Sites hosts the web app; run the independent scheduler on a persistent Node/Docker host with the same database. Alternatively, an authenticated external scheduler may call `POST /api/jobs/run` every 15 seconds on a reachable deployment using `Authorization: Bearer WORKER_SECRET`. An owner-private Sites gate blocks ordinary external HTTP schedulers, so use the direct database worker for private review.

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

Full tests require a Neon database named exactly `samana_qms_test`. Put its URL and synthetic QR/origin settings in ignored `.env.test`, then migrate it using `node --env-file=.env.test scripts/migrate.mjs`. Tests refuse another database name. Salesforce is mocked in API tests; live read-only verification is separate. Unit tests can run without a database: `npx vitest run tests/domain.test.ts tests/groups.test.ts`.

CI checks types, lint, unit tests, dependency audit and both builds. The database job requires the `qms-test` environment secret `QMS_TEST_DATABASE_URL`; it deliberately fails when that secret is absent. Browser/device acceptance remains pending because no controllable browser was connected during implementation. Test real mobile QR scanning, Arabic layout, desktop notifications, printing, TV fullscreen/audio, and reconnect behavior before launch.

## Operations

See [operations](docs/operations.md) for schema ownership, monitoring, recovery, retention, and release procedure. Backend logic uses parameterized SQL and database transactions; the browser never talks directly to PostgreSQL or Salesforce. No sample customer records are seeded into the app database.
