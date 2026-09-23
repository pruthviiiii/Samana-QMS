# Deployment specification

For the engineer setting up hosting and CI/CD. Host-agnostic: it states what
each process needs, not which vendor to buy. Everything here is derived from
the code, and the file that enforces each claim is named so you can check it.

---

## Read this first — three things that catch people out

### 1. There are three processes, not two

"Frontend and backend" is two. This system is **three**, and the third is the
one that silently breaks a launch:

| Process | Kind | If it is missing |
|---|---|---|
| `web` | HTTP, public | Nothing works — this is the only public entry point. |
| `api` | HTTP, internal | Nothing works — the web tier forwards every `/api` call to it. |
| `scheduler` | **Worker, no port** | Check-in still works and staff can still call customers by hand, so it looks fine. But nothing is re-routed, no abandoned ticket is picked up, and **no visit ever reaches Salesforce**. It fails quietly. |

The scheduler has no HTTP port and no URL. On platforms that only offer "web
services" it is deployed as a *background worker* / *daemon* type.

### 2. The web tier is not a static site

`next.config.ts` sets `output: 'standalone'` and `proxy.ts` issues a fresh
Content-Security-Policy nonce per request, so pages render per request. It
**requires a Node.js runtime**. It cannot be exported to a static host, a CDN
bucket, or anything that serves only files.

### 3. Build needs dev dependencies; runtime does not

The build runs TypeScript, Next.js and `prisma generate` — all dev
dependencies. With `NODE_ENV=production` set, `npm ci` skips them by default,
and the build fails with a missing-module error that looks unrelated.

```bash
npm ci --include=dev      # build stage
npm run build:<target>
```

---

## Source layout

No code needs moving. The separation already exists and is enforced by
`tests/boundary.test.ts`, which fails the build if a server module is ever
imported into browser code.

### Frontend — ships to the browser

| Path | Contents |
|---|---|
| `app/` | Next.js routes and layouts — check-in, visit status, print receipt, workspace shell |
| `components/qms/` | Screens: staff workspace, reception board, check-in, team, reports, settings |
| `components/ui/` | Shared interface primitives |
| `proxy.ts` | Runs before every request: forwards `/api`, sets security headers |
| `instrumentation.ts` | Validates the web tier's configuration at boot |
| `next.config.ts`, `postcss.config.mjs` | Build configuration |

### Backend — never reaches the browser

| Path | Contents |
|---|---|
| `server/` | API entry point and request handler |
| `lib/api/` | The route table — 32 routes, each declaring its own access rule |
| `lib/data/` | Database access: Prisma for records, validated SQL for the queue engine |
| `lib/router.ts`, `lib/http.ts`, `lib/errors.ts` | Routing, requests, error mapping |
| `lib/db.ts`, `lib/prisma.ts` | Connection pool and typed client |
| `lib/salesforce.ts`, `lib/jobs.ts` | Integration and delivery |
| `lib/config.ts`, `lib/security.ts` | Configuration validation, password and token handling |
| `db/` | Migrations and the generated schema snapshot |
| `prisma/` | Introspected schema |
| `scripts/` | Build, migrate, provision, bootstrap |

### Shared by both

| Path | Why it is safe in the browser |
|---|---|
| `lib/domain.ts` | Types, service list, role names, validation rules. No I/O. |
| `lib/client.ts` | Browser-side fetch helper. |
| `lib/utils.ts` | Small pure helpers. |

> The web tier holds **no database credential and no Salesforce credential**.
> That is the security boundary, and it is why the tiers are separate.

---

## Per-process specification

### `web` — public HTTP

| | |
|---|---|
| Install | `npm ci --include=dev` |
| Build | `npm run build:node` |
| Start | `node dist-node/standalone/server.js` |
| Listens on | `PORT`, default `3000` |
| Health check | `GET /api/health` → `200 {"status":"ready"}` |
| Scaling | Stateless. Run as many as you like behind a load balancer. |
| Environment | `deploy/web.env.example` — **4 variables, no secrets except the proxy token** |

Health goes *through* the proxy to the API, so a passing check proves the whole
chain, not just that the process is up.

### `api` — internal HTTP

| | |
|---|---|
| Install | `npm ci --include=dev` |
| Build | `npm run build:api` |
| **Pre-deploy** | `node scripts/migrate.mjs` — see *Release procedure* |
| Start | `node dist-api/api.mjs` |
| Listens on | `API_PORT`, or `PORT` if the platform assigns one. Default `3001` |
| Health check | `GET /api/health` |
| Scaling | Stateless, but see *Scaling notes* — each instance holds one database listener. |
| Environment | `deploy/api.env.example` — database, Salesforce, SMS, all secrets |

### `scheduler` — background worker, no port

| | |
|---|---|
| Install | `npm ci --include=dev` |
| Build | `npm run build:worker` |
| Start | `node dist-worker/worker.mjs` |
| Listens on | **Nothing.** Do not assign a port or a health-check URL. |
| Health check | Not HTTP. Query `GET /api/health/scheduler` on the API, which reports whether the tick is recent. |
| Scaling | **Exactly one instance.** Two schedulers do no harm — the work is lock-protected — but they double the load for no benefit. |
| Environment | `deploy/scheduler.env.example` — database and integrations, no ports, no proxy token |

It connects straight to the database. It does not call the API and needs no
network route to it.

---

## How the processes connect

```
        browser / phone / reception TV
                    |
                    |  https, public
                    v
        +-----------------------+
        |         web           |   Node, port 3000
        |  screens + /api proxy |   no credentials
        +-----------------------+
                    |
                    |  http, private.  Adds x-internal-token
                    v
        +-----------------------+
        |         api           |   Node, port 3001
        |  route table + data   |   all credentials
        +-----------------------+
                    |                        +---------------+
                    |  postgres              |   scheduler   |  worker, no port
                    v                        +-------+-------+
        +-------------------------------------------+-------+
        |                 PostgreSQL 14+                     |
        +----------------------------------------------------+
```

**The API must not be reachable from the internet.** Put it on a private
network if the platform offers one. If it cannot be private — many platforms
give every service a public hostname — the shared-secret gate is what protects
it, and it is mandatory:

- Set the **same** `API_PROXY_TOKEN` on `web` and `api`.
- The web tier adds it as `x-internal-token` to everything it forwards.
- The API refuses any request without it, except `GET /api/health` so the load
  balancer can probe.
- A production API **refuses to start** without it (`lib/config.ts`,
  `assertApiConfig`). Set `API_TRUSTS_NETWORK=true` instead *only* if the
  address is genuinely unreachable from outside.

The scheduler needs neither the token nor a route to the API.

---

## Database

PostgreSQL **14 or newer**. Tested on 18.

### Provisioning

Two roles, deliberately:

| Role | Used by | Rights |
|---|---|---|
| `qms_owner` | Migrations only | Owns the schema; can change it |
| `qms_app` | web / api / scheduler at runtime | Read and write rows, execute functions. **No DDL.** |

Run **one** of:

- `node scripts/create-app-role.mjs` with `MIGRATE_DATABASE_URL` set to the
  owner — creates the role, prints the connection string, and is re-runnable to
  refresh grants after a migration adds objects; or
- `deploy/provision-database.sql` — the same thing as plain SQL for a DBA who
  will not run Node. Read the header before running it.

### Connection strings

```
# Runtime — restricted role
DATABASE_URL=postgresql://qms_app:PASSWORD@HOST:5432/samana_qms?sslmode=verify-full

# Migrations only — owner
MIGRATE_DATABASE_URL=postgresql://qms_owner:PASSWORD@HOST:5432/samana_qms?sslmode=verify-full
```

Add `?sslmode=verify-full` for any managed or remote server. Omit it only for a
plain local server with no TLS.

### Two settings that affect behaviour

**Connection pooling.** Each API instance opens up to 10 connections
(`lib/db.ts`). Size the server's `max_connections`, or the pooler's limit, for
`instances × 10` plus headroom for the scheduler and migrations.

**Live screen updates need one un-pooled connection.** The reception television
and staff screens update instantly because one database session per API process
holds `LISTEN qms_changes`. A pooler in *transaction* mode accepts that command
and then never delivers a notification — silently. Screens keep working, but
fall back to polling every 30 seconds instead of updating immediately.

- On Neon this is handled automatically: `lib/events.ts` rewrites a `-pooler`
  hostname to the direct endpoint for that one connection.
- Behind PgBouncer or similar, either use *session* mode, or allow that one
  connection to bypass the pooler.

### After any restore or first migration

```sql
ANALYZE;
```

Without planner statistics the queue sweep measured four times slower and the
read-path indexes were ignored. This is a required step, not a tuning tip.

---

## Release procedure

Order matters. Migrations run **before** the new API starts.

1. **Snapshot the database.** Migrations are forward-only; there are no
   automatic down scripts. On a managed host with a short point-in-time window
   this snapshot is the real restore point. See `docs/rollback.md`.
2. Build all three artifacts.
3. Run `node scripts/migrate.mjs` with `MIGRATE_DATABASE_URL`. It is
   idempotent, checksums every applied file, and refuses to run one that was
   edited after it was applied.
4. Release `api`, then `web`, then `scheduler`. Any order works in practice —
   see the note below — but this one minimises the window.
5. Verify (next section).

> **The window between step 3 and step 4 is safe by design.** For a short time
> the new schema runs under the old application. Every migration keeps the
> function signatures the previous version calls, and the application never
> queries the queue engine's tables directly. During the last release the old
> code ran against the new schema for about ninety seconds with no error.

### First deployment only

```bash
node scripts/migrate.mjs          # create the schema
node scripts/create-app-role.mjs  # create the restricted runtime role
node scripts/bootstrap.mjs        # create the first administrator
```

Then **remove `BOOTSTRAP_PASSWORD` from the API and scheduler environments.**
While it is still set in production, `GET /api/health/alerts` reports
`bootstrap_password_present` and returns 503.

---

## Verification after a release

Health endpoints return 200 throughout a deploy because the *old* build is
still serving. They confirm the platform is healthy, not that your release
landed. Check both.

```bash
# 1. The chain is up
curl -fsS https://<web-host>/api/health
# → {"status":"ready"}

# 2. Nothing needs a person
curl -fsS https://<web-host>/api/health/alerts
# → {"status":"ready","problems":[]}
#   503 lists: scheduler_stale | outbox_failed:N | salesforce_paused |
#              bootstrap_password_present

# 3. The scheduler is actually ticking — run twice, 20s apart.
#    lastRun must advance. If it does not, the worker is not running.
curl -fsS https://<web-host>/api/health/scheduler

# 4. The API is not reachable directly (only if it has a public address)
curl -s -o /dev/null -w '%{http_code}\n' https://<api-host>/api/queue
# → 401 or 404. A 200 means the gate is missing. Stop and fix.

# 5. Browser security headers
node scripts/security-smoke.mjs https://<web-host>
```

Then confirm the release actually shipped: probe something only the new build
has — a new route answering `403` instead of `404`, or a new asset — rather
than trusting a green health check.

---

## Scaling notes

| Component | Guidance |
|---|---|
| `web` | Scale freely. Stateless. |
| `api` | Scale freely, but each instance holds one `LISTEN` connection plus up to 10 pooled connections. Budget database connections accordingly. |
| `scheduler` | **One instance.** |
| Database | Single writer for queue assignment by design — one advisory lock serialises it. Sized for one branch and roughly 20 staff. Measured: 400 waiting tickets and 20 staff hold the lock for at most 53 ms. Revisit before a second site. |

---

## Common mistakes

| Symptom | Cause |
|---|---|
| Build fails on a missing module | `npm ci` without `--include=dev` while `NODE_ENV=production` |
| Everything works but nothing is ever assigned, and Salesforce gets nothing | The scheduler was never deployed |
| Nobody can sign in | `SESSION_COOKIE_SECURE=true` with an `http://` origin, or `false` with `https://`. The two must agree; the process refuses to start if they do not. |
| Web tier returns 503 `API_NOT_CONFIGURED` | `API_URL` not set on the web tier |
| API returns 401 `NOT_VIA_WEB_TIER` for everything | `API_PROXY_TOKEN` differs between web and API |
| API refuses to start in production | No `API_PROXY_TOKEN` and no `API_TRUSTS_NETWORK=true` |
| Screens update slowly but correctly | The `LISTEN` connection is going through a transaction-mode pooler |
| Origin errors on every save | `APP_ORIGIN` is not the exact address users reach, including scheme and any port |

---

## Files in this directory

| File | Purpose |
|---|---|
| `web.env.example` | Environment for the web tier — 4 variables |
| `api.env.example` | Environment for the API — database, integrations, secrets |
| `scheduler.env.example` | Environment for the scheduler |
| `provision-database.sql` | Database, roles and grants for a DBA |

Container images for all three tiers are in the repository root `Dockerfile`
(targets `web`, `api`, `worker`); `compose.yaml` runs the three together on one
host. `render.yaml` is a working blueprint for Render if that is the platform
chosen — read it as a concrete example of the specification above.
