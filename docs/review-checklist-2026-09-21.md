# Review checklist, 21 September 2026

Every issue raised by the external code review (Samana-QMS-Code-Review.pdf), by the internal architecture review and by the production-path note, with its current state. A ticked box means the change is in the repository and covered by the checks in "Verification" below. An open box names who has to decide or act.

**Ticked: 32 of 51.** Of the 19 open boxes, 13 need a business, IT or Salesforce decision and 6 are further engineering work that was not started.

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
- [ ] SSO or MFA for staff sign-in. Needs an IT decision on the identity provider.
- [ ] Offboarding lifecycle beyond disabling the account. Needs an HR/IT process definition.
- [ ] OTP on mobile check-in, which closes identifier probing. Needs the SMS gateway first.
- [ ] Restricted `qms_app` database role, Neon IP allow list, longer point-in-time recovery window, and a Neon project separate from Samana Living. IT and the account owner.

## B. Reliability and operations

- [x] A Salesforce outage no longer blocks check-in: a circuit breaker pauses lookups for 30 s after three failures, and staff can issue an audited walk-in ticket. `lib/salesforce.ts`, `lib/api/tickets.ts`, `components/qms/check-in.tsx`.
- [x] Every API response carries `X-Request-Id`, and one structured log line per request records method, path, status and duration. `lib/http.ts`.
- [x] `GET /api/health/scheduler` returns 503 when the worker heartbeat is older than 90 s, and heartbeat expiry is audited. `lib/api/public.ts`, migration 012.
- [x] Retention job: expired unreferenced lookups and idle guest users are purged after one day, alongside expired sessions and old rate-limit rows. Migration 012.
- [x] Database access uses a connection pool with real `BEGIN`/`COMMIT` transactions and statement timeouts instead of one HTTP client per query. `lib/db.ts`, `lib/public-access.ts`.
- [x] Database error codes map to human messages (for example "This ticket was just updated by someone else"). `lib/http.ts`.
- [x] Registered customers with no units can take a General Query ticket instead of being refused. Migration 012, `components/qms/check-in.tsx`.
- [ ] Alerts on a stale scheduler heartbeat or failed outbox rows. The health endpoint and JSON logs exist; the alert has to be configured in Render or the monitoring tool.
- [ ] A rehearsed backup restore into a Neon branch. Operational, not yet exercised.
- [ ] Retention period for audit events and customer identifiers on tickets. Nothing is deleted today; needs a data-governance decision.

## C. Live updates and performance

- [x] Server-sent events fed by PostgreSQL `NOTIFY` replace five-second polling on the queue and TV; screens poll every 30 s as a safety net while live, every 5 s (TV 3 s) if the stream drops. `db/013_change_notifications.sql`, `lib/events.ts`, `lib/api/events.ts`, `components/qms/use-live.ts`, `components/qms/use-queue.ts`. The listener always connects to Neon's direct endpoint because the pooled endpoint accepts `LISTEN` but never forwards notifications (verified 21 September).
- [x] The TV shows a sign-in message when its session expires instead of "Reconnecting" forever, keeps the sound preference, and refreshes on live changes. `components/qms/tv-display.tsx`.
- [x] The ticket drawer refreshes every 5 s while open, and the visit page stops polling once the visit is closed or missing. `components/qms/ticket-detail.tsx`, `components/qms/mobile-visit.tsx`.
- [x] The team list is fetched only when reassigning. `components/qms/ticket-detail.tsx`.
- [ ] Single advisory lock around queue writes. Kept deliberately: it settles races in the database for one centre. Revisit only if the load test below shows contention.
- [ ] Load test at the expected number of consoles and TVs. Operational, pending.

## D. Code quality and maintainability

- [x] The beta framework `vinext 1.0.0-beta.10` is replaced by Next.js 16.3.5 with standalone output. `package.json`, `next.config.ts`, `proxy.ts`, `scripts/build.mjs`, `Dockerfile`, `render.yaml`.
- [x] The single 475-line API if-chain is split into per-resource modules with declarative routes and proper verbs (`PUT`, `PATCH`, `DELETE`). `lib/api/`.
- [x] The app shell is split into login, audit, queue table and data hooks, and the Team, Queues, Reports, Settings, TV and Audit views load on demand. `components/qms/`.
- [x] Roles and service ids come from one domain module instead of being retyped in each schema. `lib/domain.ts`, `lib/api/shared.ts`.
- [x] 54 unused UI components, the unused mobile hook and the Vite, Cloudflare and OpenAI configuration are removed (about 2,800 lines).
- [x] A schema snapshot generated from the database, with a drift test, replaces reading four generations of `CREATE OR REPLACE FUNCTION`. `db/schema.sql`, `scripts/schema-snapshot.mjs`, `tests/schema.test.ts`.
- [x] Migrations are checksummed; editing an applied migration is refused. `scripts/migrate.mjs`.
- [ ] React error boundaries around the lazy views. Not started.
- [ ] One styling system. About 6,300 lines of CSS remain across three files. Not started.
- [ ] Published OpenAPI document. Not started; the route table in `lib/api/` is the current source of truth.
- [ ] Browser tests (Playwright) for check-in, queue and TV flows. Not started.
- [ ] ORM or typed data layer (the review suggested Prisma). Decision: keep parameterized SQL and PL/pgSQL functions; the router and schema snapshot address the maintainability concern.

## E. Build, CI and deployment

- [x] CI no longer references the deleted `tests/groups.test.ts`; the database-free unit tests are listed explicitly. `.github/workflows/quality.yml`.
- [x] The database test suite runs on pull requests as well as pushes to main. `.github/workflows/quality.yml`.
- [x] The misleading `start:cloudflare` script is gone; `npm start` runs the standalone server that Render and Docker start. `package.json`.
- [x] The build runs in place and produces the same standalone output locally, in Docker and on Render. `scripts/build.mjs`, `Dockerfile`.
- [x] Test suite grown to 129 tests: route table, schema drift, audit trail, walk-ins, no-unit visits, presence audit, work factor, listener endpoint.
- [ ] Ephemeral Neon branch per pull request for database tests. Uses the fixed `samana_qms_test` database today.

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
| `npm test` (needs `samana_qms_test`) | 129 passed |
| `npm run build` (Next.js standalone) | passed, 34 MB output |
| `npm run build:worker` | passed |
| Standalone server against the test database | health 200 with request id, unknown view 404, hidden path 404, CSP and frame headers present, unauthenticated API 401, POST without Origin 403, sign-in 200, event stream forbidden until the temporary password is changed, then `listening: true` and a `users` change delivered |

The push to `main` deploys to Render and applies migrations 012 and 013 to production during the pre-deploy step.
