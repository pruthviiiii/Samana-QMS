# Review checklist, 21 September 2026

Every issue raised by the external code review (Samana-QMS-Code-Review.pdf), by the internal architecture review and by the production-path note, with its current state. A ticked box means the change is in the repository and covered by the checks in "Verification" below. An open box names who has to decide or act.

**Ticked: 68 of 86** (updated 22 September 2026, after the architecture review in section I). Of the 16 open boxes, 14 need a business decision or an operator outside the code, and 2 are frontend work not started (one styling system, browser tests). Every item the external review raised that is a code defect is closed and tested; the point-by-point response is `docs/review-response-2026-09-22.html` (PDF beside it).

## A. Security and access

- [x] Sign-in, sign-out and failed sign-ins are written to the audit table (`login`, `login_failed`, `logout`). `lib/api/auth.ts`, commit 3aac449.
- [x] Staff going online or offline is audited (`presence_online`, `presence_offline`). `db/012_audit_retention_and_walkins.sql`.
- [x] Password hashing raised from 100,000 to 600,000 PBKDF2-SHA256 iterations, with transparent rehash at the next sign-in. `lib/security.ts`, `scripts/bootstrap.mjs`.
- [x] Every API route declares its method, path and required authentication (`public`, `worker`, `session` or a role list) in one table, and the Origin check, worker bearer check and forced password change are enforced in one place. `lib/router.ts`, `lib/api/*.ts`, `tests/routes.test.ts` asserts the set of unauthenticated and guest-reachable routes.
- [x] Password change asks for a confirmation and explains that other sessions are signed out. `components/qms/settings.tsx`.
- [x] Rate-limit windows start at the first attempt. Clock-aligned windows let a burst that straddled a five-minute boundary use twice the budget. `lib/http.ts`.
- [x] Unknown views and hidden paths (for example `/.env`) return 404. `app/[view]/page.tsx`, `app/not-found.tsx`, `proxy.ts`.
- [x] Security headers, CSP and HSTS are applied by the real Next.js proxy and static header config rather than by the beta framework's shim. `proxy.ts`, `next.config.ts`.
- [x] Settings warns when the bootstrap password is still present on the host and when Salesforce is paused. `lib/salesforce.ts`, `components/qms/settings.tsx`.
- [x] In production the alert endpoint also reports a bootstrap password left on the host, so the uptime monitor pages until it is removed. `lib/api/public.ts`.
- [x] Report exports carry customer identifiers only when the manager ticks the option; every report export and audit export is recorded with its filters. `lib/operations.ts`, `lib/api/reports.ts`, `components/qms/reports.tsx`.
- [x] The audit trail exports as CSV with the same filters. `lib/operations.ts`, `components/qms/audit.tsx`.
- [x] Browser code cannot import server modules: a test pins the client-safe modules and the single API entry point. `tests/boundary.test.ts`.
- [ ] SSO or MFA for staff sign-in. Needs an IT decision on the identity provider.
- [ ] Offboarding lifecycle beyond disabling the account. Needs an HR/IT process definition.
- [ ] OTP on mobile check-in, which closes identifier probing. Needs the SMS gateway first.
- [x] Restricted `qms_app` database role: `scripts/create-app-role.mjs` creates it with data and function access only; applied to the local and test databases, and the full suite runs as that role. Migrations use `MIGRATE_DATABASE_URL`. For production, run the script once and set both strings on Render.
- [x] Per-address rate limits key on the address the proxy appended, not a forged prefix; the Render blueprint sets `TRUSTED_CLIENT_IP_HEADER`. `lib/http.ts`, `render.yaml`.
- [ ] Database network restrictions (firewall or allow list for Render's outbound addresses), a backup and recovery window, and a server or project that is not shared with Samana Living. IT and the account owner.

## B. Reliability and operations

- [x] A Salesforce outage no longer blocks check-in: a circuit breaker pauses lookups for 30 s after three failures, and staff can issue an audited walk-in ticket. `lib/salesforce.ts`, `lib/api/tickets.ts`, `components/qms/check-in.tsx`.
- [x] Every API response carries `X-Request-Id`, and one structured log line per request records method, path, status and duration. `lib/http.ts`.
- [x] `GET /api/health/scheduler` returns 503 when the worker heartbeat is older than 90 s, and heartbeat expiry is audited. `lib/api/public.ts`, migration 012.
- [x] Retention job: expired unreferenced lookups and idle guest users are purged after one day, alongside expired sessions and old rate-limit rows. Migration 012.
- [x] Database access uses a connection pool with real `BEGIN`/`COMMIT` transactions and statement timeouts instead of one HTTP client per query. `lib/db.ts`, `lib/public-access.ts`.
- [x] Database error codes map to human messages (for example "This ticket was just updated by someone else"). `lib/http.ts`.
- [x] Registered customers with no units can take a General Query ticket instead of being refused. Migration 012, `components/qms/check-in.tsx`.
- [x] One alert endpoint, `GET /api/health/alerts`, returns 503 while the scheduler is stale, a delivery has given up or Salesforce is paused. `lib/api/public.ts`.
- [x] Retention job: `qms.apply_retention` anonymises the name and identifiers on closed tickets and deletes old audit events, driven by `RETENTION_IDENTIFIER_DAYS` and `RETENTION_EVENT_DAYS`, at most hourly from the scheduler tick. Migration 014, `lib/retention.ts`.
- [x] Tickets left waiting or called from a previous day are marked no-show two hours after issue, and a number an earlier day's ticket still shows is skipped. Migration 014.
- [x] Malformed paging parameters (`page=Infinity`) return 400 instead of a database error. `lib/http.ts`, `lib/operations.ts`.
- [x] The migration runner applies only numbered files. It had been picking up `db/schema.sql` and would have failed the Render pre-deploy step. `scripts/migrate.mjs`, `scripts/sql.mjs`.
- [x] Migrations 012 to 015 applied to the local `samana_qms` database as well as `samana_qms_test`.
- [x] The Render worker runs in direct database mode: routing tick, deliveries and retention without an HTTP hop or a shared secret between the services. `render.yaml`, `scripts/worker-entry.ts`.
- [ ] Point an uptime monitor at `/api/health/alerts`. Render or the monitoring tool, IT.
- [ ] A rehearsed backup restore into a Neon branch, following the steps in `docs/operations.md`. Operational, not yet exercised.
- [ ] Choose the two retention periods. Off (keep everything) until set. Product and IT.

## C. Live updates and performance

- [x] Server-sent events fed by PostgreSQL `NOTIFY` replace five-second polling on the queue and TV; screens poll every 30 s as a safety net while live, every 5 s (TV 3 s) if the stream drops. `db/013_change_notifications.sql`, `lib/events.ts`, `lib/api/events.ts`, `components/qms/use-live.ts`, `components/qms/use-queue.ts`. The listener always connects to Neon's direct endpoint because the pooled endpoint accepts `LISTEN` but never forwards notifications (verified 21 September).
- [x] The TV shows a sign-in message when its session expires instead of "Reconnecting" forever, keeps the sound preference, and refreshes on live changes. `components/qms/tv-display.tsx`.
- [x] The ticket drawer refreshes every 5 s while open, and the visit page stops polling once the visit is closed or missing. `components/qms/ticket-detail.tsx`, `components/qms/mobile-visit.tsx`.
- [x] The team list is fetched only when reassigning. `components/qms/ticket-detail.tsx`.
- [x] A dead screen stops receiving customers 45 seconds after its last heartbeat (15-second heartbeat, migration 015) and its waiting customers move on within 60 seconds; the windows were 90 and 105 seconds. `db/015_presence_window.sql`, `components/qms/app.tsx`.
- [x] The TV announces the ticket already showing when it loads, browser permitting. `components/qms/tv-display.tsx`.
- [x] The single lock is measured: 200 concurrent check-ins in 1.3 s, the routing tick with 200 to 400 waiting customers holds the lock for 96 to 214 ms, and 1,200 parallel agent actions run at a median of 11 ms. `scripts/load-check.mjs`.
- [ ] Single advisory lock around queue writes. Kept deliberately: it settles races in the database for one centre and the measurement above shows it idle almost all the time. Revisit only if a load test at the real counter count shows contention.
- [ ] Load test at the expected number of consoles and TVs. Operational, pending.

## D. Code quality and maintainability

- [x] The beta framework `vinext 1.0.0-beta.10` is replaced by Next.js 16.3.5 with standalone output. `package.json`, `next.config.ts`, `proxy.ts`, `scripts/build.mjs`, `Dockerfile`, `render.yaml`.
- [x] The single 475-line API if-chain is split into per-resource modules with declarative routes and proper verbs (`PUT`, `PATCH`, `DELETE`). `lib/api/`.
- [x] The app shell is split into login, audit, queue table and data hooks, and the Team, Queues, Reports, Settings, TV and Audit views load on demand. `components/qms/`.
- [x] Roles, role groups and service ids come from one domain module; the route table's access groups and the workspace's role predicates are the same constants, so nothing is retyped in the browser. `lib/domain.ts`, `lib/api/shared.ts`, `components/qms/app.tsx`.
- [x] 54 unused UI components, the unused mobile hook and the Vite, Cloudflare and OpenAI configuration are removed (about 2,800 lines).
- [x] A schema snapshot generated from the database, with a drift test, replaces reading four generations of `CREATE OR REPLACE FUNCTION`. `db/schema.sql`, `scripts/schema-snapshot.mjs`, `tests/schema.test.ts`.
- [x] Migrations are checksummed; editing an applied migration is refused. `scripts/migrate.mjs`.
- [x] React error boundaries around every lazy view and the TV: a failing view shows a retry panel instead of blanking the workspace. `components/qms/view-boundary.tsx`.
- [ ] One styling system. Three files remain. On 22 September the overlap was measured (202 of 623 selectors defined in more than one file, 7 of 12 root variables redefined) and the 91 blocks that a later identical selector fully overrode were removed with a proof that no surviving rule changed; the 230 partial overlaps change styles if touched and need a design decision, not a code one.
- [x] OpenAPI document generated from the route table with each route's access and request schema; `npm run api:docs` writes it and a test fails when it is stale. `lib/openapi.ts`, `docs/openapi.json`.
- [x] Component tests in a DOM for the check-in screen (identifier types, lookup, failure, walk-in path, ticket issue, Arabic and right-to-left) and the live queue table (states, wait warning, empty states, opening a ticket). `tests/ui/`, run as the `browser` project.
- [ ] End-to-end browser tests (Playwright) on real devices for the TV and printing. Device acceptance before launch.
- [ ] ORM or typed data layer (the review suggested Prisma). Decision: keep parameterized SQL and PL/pgSQL functions; the router and schema snapshot address the maintainability concern.

## I. Architecture review of 22 September 2026

A second, stricter pass over the code as an enterprise architect would read it. Every finding and what was done.

- [x] One validated configuration boundary. Every setting is read in `lib/config.ts`, validated once at start and frozen; the server and the scheduler refuse to boot on a missing or contradictory value with a message naming it. The session cookie's Secure flag must agree with the origin's scheme. A test pins that only four files may read the environment. `lib/config.ts`, `instrumentation.ts`, `tests/config.test.ts`, `tests/boundary.test.ts`.
- [x] Nonce-based script policy. A nonce is minted per request, `strict-dynamic` covers the chunks it loads, and `'unsafe-inline'` is gone from `script-src`. Every page renders per request so the nonce is always current. Proven on the built server: 15 script tags, 15 carrying the nonce, and a headless browser hydrated the login form with zero policy violations. `proxy.ts`, `app/layout.tsx`, `tests/proxy.test.ts`.
- [x] Indexes for the three queries on a timer (unread notifications on every queue refresh, the outbox claim every 15 s, the lookup reuse check on every check-in) and for the audit trail filtered by action. `db/016_hot_path_indexes_and_limits.sql`.
- [x] Atomic rate limiter: one row per key, one upsert, no window race. Same migration; `lib/http.ts`.
- [x] Routing and delivery on separate timers in the scheduler, so a slow integration never delays the routing tick. Graceful shutdown closes the pool. `scripts/worker-entry.ts`.
- [x] Typed errors. Every failure carries a stable `code`; database rules map by SQLSTATE and exact rule name instead of a substring of the message; the Salesforce client carries the org's status on the error; an unexpected fault is a 500 with a request id, not a 503. `lib/errors.ts`, `lib/http.ts`, `lib/salesforce.ts`, `lib/client.ts`.
- [x] Salesforce client hardening: the health probe is held for 60 s so opening Settings does not spend Apex calls, and a response body that cannot be read no longer trips the circuit breaker. `lib/salesforce.ts`.
- [x] Workspace navigation through the framework router; the address is the view, and the hand-rolled history listener is gone. `components/qms/app.tsx`.
- [x] Refs are written in effects, never during render. `components/qms/use-queue.ts`, `components/qms/use-live.ts`.
- [x] Dead duplicate rules removed: the TypeScript copies of the ticket lifecycle and SMS eligibility, which nothing called, are gone; the database functions are the one definition and the workflow tests cover them. `lib/domain.ts`.
- [x] Graceful shutdown for the web server: the pool and the change listener close on SIGTERM. `lib/lifecycle.ts`.
- [x] A reception TV keeps its display session when the check-in link is opened on it. `lib/public-access.ts`.
- [x] The delivery worker checks that the ticket still exists before building a payload; the last non-null assertion in the codebase is gone. `lib/jobs.ts`.
- [x] The ticket-lifecycle API tests are a self-contained sequential scenario that issues its own ticket, instead of sharing module state with earlier cases. `tests/api.test.ts`.
- [x] Coverage is measured and gated: two test projects (server and browser), `npm run test:coverage`, thresholds in `vitest.config.ts`, enforced in CI.
- [ ] The application role may execute every function, including retention and the routing tick. Kept: the scheduler runs as the same role by design, and a third credential for two functions adds operational surface for little gain. Revisit if the worker ever gets its own role.
- [ ] Three stylesheets. See section D; the provably dead blocks are gone, the rest is a design decision.

## E. Build, CI and deployment

- [x] CI no longer references the deleted `tests/groups.test.ts`; the database-free unit tests are listed explicitly. `.github/workflows/quality.yml`.
- [x] The database test suite runs on pull requests as well as pushes to main. `.github/workflows/quality.yml`.
- [x] The misleading `start:cloudflare` script is gone; `npm start` runs the standalone server that Render and Docker start. `package.json`.
- [x] The build runs in place and produces the same standalone output locally, in Docker and on Render. `scripts/build.mjs`, `Dockerfile`.
- [x] Test suite grown to 141 tests: route table, schema drift, API document, audit trail, walk-ins, no-unit visits, presence audit, work factor, listener endpoint, day rollover, number reuse, retention, alerts, paging, forged client addresses, migration file filter.
- [x] CI runs the database suite against a PostgreSQL 18 container started inside the workflow, so every pull request and push is tested on a fresh database with no external service and no secret. `.github/workflows/quality.yml`.
- [x] No host-specific database code: the standard `pg` driver replaces Neon's, so the same build runs on your own PostgreSQL server, a managed service, or Neon. `lib/db.ts`, `lib/events.ts`, `scripts/db.mjs`.

## F. Queue behaviour raised by the review, kept by design

- [ ] Per-service round robin: cross-service work is not counted and a newly added member is served first. Needs a decision from the CRM and Collection managers before the rule changes.
- [ ] Priority or VIP handling. Not in the BRD.
- [ ] Preferred owner wins over round robin. BRD requirement, kept.
- [ ] Assignment at check-in, before the call. Kept; the scheduler re-routes after five minutes.

## G. Claims checked and found not to be defects

No box, because nothing needed changing:

- Assignment only happens when the scheduler calls: `qms.issue_ticket` routes in the same transaction at check-in.
- The SQL splitter has no tests: two tests in `tests/domain.test.ts` cover it.
- "People ahead of you" counts the whole service: the query counts only earlier waiting tickets.
- No transactions: guest creation and migrations already used them; the pool now gives interactive transactions everywhere.
- Four live routing rules compete: `CREATE OR REPLACE` replaces a function; the snapshot shows the one current definition.
- `wrangler dev` is the production start command: Render and Docker start the standalone server. The confusing script is now removed anyway.

## H. Production path (owners outside the code)

- [ ] Salesforce production org: deploy `QMS_Ticket__c`, the four Apex classes and the `QMS_Access` permission set; connected app with client credentials and a dedicated integration user. Salesforce team.
- [ ] Production `Calling_List__c` and `Customer_Unit__c` ownership data complete enough for owner routing. CRM team.
- [ ] Production secrets on Render: real HTTPS origin, production Salesforce values, fresh `WORKER_SECRET` and `QR_SIGNING_SECRET`, `SALESFORCE_WRITE_ENABLED=false` until one production ticket is verified, bootstrap password removed after first sign-in. Account owner.
- [ ] SMS gateway chosen and validated for idempotency before `SMS_ENABLED=true`. Product and IT.
- [ ] Staff mapped to queues and Salesforce ids; one `display` account per TV. CRM and Collection managers.
- [ ] Device acceptance: real phones scanning the QR, Arabic layout, receipt printing, TV fullscreen and audio, desktop notifications, reconnect after Wi-Fi drops.

## Verification run on 21 September 2026

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` (needs `samana_qms_test`) | 147 passed across 12 files, run as the restricted `qms_app` role |
| `node --env-file=.env.test scripts/load-check.mjs` | 200 concurrent check-ins in 1.3 s; routing tick 19 to 214 ms with 200 to 400 waiting; 600 to 1,200 parallel agent actions at 11 to 23 ms median, 65 ms maximum |
| `npm run build` (Next.js standalone) | passed, 34 MB output |
| `npm run build:worker` | passed |
| `node scripts/migrate.mjs` on `samana_qms` and `samana_qms_test` | 012, 013, 014 applied; re-run reports all applied and exits 0 |
| `qms_app` role on both databases | reads and function calls work, `CREATE TABLE` denied |
| Standalone server against the test database | health 200 with request id, unknown view 404, hidden path 404, CSP and frame headers present, unauthenticated API 401, POST without Origin 403, sign-in 200, event stream forbidden until the temporary password is changed, then `listening: true` and a `users` change delivered |
| Local PostgreSQL 18 server (Windows service, port 5432) | `qms_owner` and both databases created; production data copied with `pg_dump`/`pg_restore`; `samana_qms_test` migrated from scratch produces a schema identical to `db/schema.sql`; `qms_app` role applied; 141 tests pass; end-to-end smoke test through the built web server and worker: health, alerts 200, sign-in, forced password change, presence, Salesforce sandbox probe connected, QR invite, guest session, guest lookup, ticket issue (idempotent), public status, call, TV board, stale version 409, start, offline-mid-service 409, close with note, history, receipt, reports JSON and CSV, audit, walk-in lookup, live `users` event, paging 400, 404s, security headers, sign-out |

## Verification run on 22 September 2026, after the architecture review

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run test:coverage` (both projects) | 175 passed across 16 files; thresholds hold at statements 36.2%, branches 33.8%, functions 26.1%, lines 38.0%; by area: server core 70% lines, API handlers 66%, screens 9% (two of seventeen components tested) |
| `npm run build`, `npm run build:worker` | passed; every route renders per request for the nonce policy |
| `node scripts/migrate.mjs` on `samana_qms` and `samana_qms_test` | 016 applied; the snapshot test passes |
| Nonce policy on the built server | 15 script tags, 15 carrying the request nonce, 0 without; no inline allowance; a headless browser hydrated the login form with 0 policy violations |
| Boot validation | The first run refused a contradictory environment and named both values; the rule was corrected to the cookie-origin invariant; the server then started and logged its configuration |
| End-to-end smoke test on the final build | all 30 steps pass (health, alerts, sign-in, forced change, presence, Salesforce probe, QR invite, guest session and lookup, idempotent issue, public status, call, TV, stale version 409, start, offline-mid-service 409, close, history, receipt, reports and CSV, audit, walk-in, live event, paging 400, 404s, headers, sign-out) |
| `scripts/load-check.mjs 20 200 20` after migration 016 | 200 check-ins in 2.2 to 3.1 s, routing tick 200 to 260 ms, actions median 57 to 76 ms on a laptop at 58% background CPU; an A/B with the indexes dropped and recreated shows no difference, so the change from the morning's 1.3 s / 96 ms / 23 ms is machine load; bloat, stray connections and advisory locks ruled out |
| Stylesheet pruning | 1,291 blocks parsed; 91 fully shadowed blocks removed; surviving blocks verified identical to the kept set; build passes |

The push to `main` deploys to Render and applies migrations 012, 013 and 014 to production during the pre-deploy step. Before that push, set `MIGRATE_DATABASE_URL` on the Render web service (the same owner string as `DATABASE_URL` is fine until the `qms_app` role exists in production).
