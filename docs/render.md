# Deploying to Render

`render.yaml` in the repository root defines everything Render needs: the web tier, the
private API service and the always-on scheduler. Render reads it when you create or sync a
Blueprint from the connected repository.

## The three services

| Service | Type | Reachable from | Holds |
| --- | --- | --- | --- |
| `samana-qms` | web | the internet | its origin and the API's private address; no credential |
| `samana-qms-api` | private service | the other two services only | the database and Salesforce credentials, the Prisma client, the route table |
| `samana-qms-scheduler` | worker | nothing (it only connects out) | the same database and integration settings, copied from the API |

The browser talks only to the web tier. The web tier forwards every `/api` request to the API
over Render's private network and passes the client address its edge appended as
`x-client-address`. Cookies stay first-party, the origin check on every state change is
unchanged, and the API has no public address at all. The scheduler runs
`node dist-worker/worker.mjs` directly against the database: no HTTP hop, no shared secret.
`POST /api/jobs/run` with `WORKER_SECRET` remains for hosts that can only run a cron-style
caller.

## One-time setup

1. Push the repository to GitHub or GitLab. Build output folders are git-ignored; Render
   builds from source on every deploy, and `npm ci` generates the Prisma client.
2. In Render: **New → Blueprint**, pick the repository, branch `main`. Render shows the three
   services from `render.yaml`.
3. Enter the `sync: false` values for the **API service** when prompted:
   - `DATABASE_URL` — the connection string for `samana_qms` as the restricted `qms_app`
     role, printed by `npm run db:app-role` (run once with the owner string).
   - `MIGRATE_DATABASE_URL` — the owner connection string; the API's pre-deploy migration
     uses it. The same owner string in both is accepted until the role exists.
   - `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` — the
     connected app credentials for the org in use.
   The scheduler copies these from the API service automatically, and the web tier receives
   only the API's private `host:port` as `API_URL`. If SMS is switched on later, add
   `SMS_GATEWAY_URL` and `SMS_GATEWAY_TOKEN` to the API service and the scheduler.
4. Apply. Render builds the three services, runs `scripts/migrate.mjs` before the API
   starts, and reports the web URL.
5. If the assigned URL differs from `https://samana-qms.onrender.com`, update `APP_ORIGIN`
   on all three services and redeploy.

## Upgrading an existing deployment

A deployment created before the API became its own service has a web service that used to
host the API itself. After the code that splits them is on `main`, that web service forwards
`/api` to `API_URL`, which it does not have until the Blueprint is synced, and answers every
API call with `503 API_NOT_CONFIGURED` in the meantime. Sync the Blueprint straight after
the push: Render creates `samana-qms-api`, moves the secrets to it (you are asked for them
once), and wires `API_URL` into the web service. Existing services created by hand are not
reconfigured by a Blueprint file; confirm their build and start commands match `render.yaml`.

## Validation at start

All three services validate every setting when they start (`lib/config.ts`). A deploy with a
missing or contradictory value fails at boot with a message naming the variable and Render
keeps the previous version serving. The web tier needs only `APP_ORIGIN` and `API_URL`; the
API and the scheduler need the database, origin, cookie and integration settings. The two
rules most likely to bite: `SESSION_COOKIE_SECURE` must be `true` when `APP_ORIGIN` is
`https://` (it is, in the Blueprint), and switching `SMS_ENABLED` or
`SALESFORCE_WRITE_ENABLED` on requires the matching connection values.

Every page renders per request. The browser policy allows scripts only by a nonce minted for
that request, so a prerendered page would carry a stale nonce; this costs a server render per
page load and buys a policy that refuses injected scripts outright.

## First run

`DATABASE_URL` can point at any PostgreSQL server Render can reach over the network (a
managed service, or a company server with TLS and a firewall rule for Render's outbound
addresses). The database already contains the administrator account if you reuse the
existing database. For an empty database, open the API service's shell in Render and run:

```sh
BOOTSTRAP_PASSWORD='<at least 14 characters>' node scripts/bootstrap.mjs
```

Then sign in at the web URL as `admin` and change the password when prompted, and remove
`BOOTSTRAP_PASSWORD` from the service: in production its presence pages the uptime monitor.

## Verifying

- `https://<web-url>/api/health` returns `{"status":"ready"}`. It travels web tier → API →
  database, so it proves the whole chain.
- `https://<web-url>/api/health/alerts` returns 200 once the scheduler has ticked; point the
  uptime monitor at this address so a stale scheduler, a failed delivery, a paused Salesforce
  connection or a bootstrap password left behind pages someone.
- Settings → Connected systems shows Salesforce connected and the scheduler healthy
  within 30 seconds of the worker starting.
- Issue one ticket from the overview page and confirm it appears in the live queue.
- Run `node scripts/security-smoke.mjs https://<web-url>` to check headers and access guards.
- The API service's logs show `config_loaded` and `api_listening` at start; the web tier's
  show `web_config_loaded`.

## Switching to another Salesforce org (UAT, production)

Change the three `SALESFORCE_*` values on the API service and redeploy the API and the
scheduler. Nothing else changes. Keep `SALESFORCE_WRITE_ENABLED` at `false` until the target
org has the `QMS_Ticket__c` object, the Apex REST classes, and a dedicated integration user
with the `QMS_Access` permission set.

## Operational notes

- Private services and always-on workers need paid plans; review the cost in Render before
  applying a Blueprint. No service plan is changed by local tests.
- If database network restrictions are enabled, configure them using the actual outbound
  addresses listed for the API and scheduler services; the web tier never reaches the database.
- Logs for all three services are in the Render dashboard. The scheduler logs one JSON line
  per tick; the API logs one JSON line per request with a request id.
- Rollback: Render keeps previous deploys. Use **Manual Deploy → Rollback** on the service
  that changed; migrations are additive and do not need reverting.
- After a migration that changes a table, run `npm run prisma:pull` locally and commit the
  refreshed `prisma/schema.prisma`; the test suite fails until you do.
