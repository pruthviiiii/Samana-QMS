# Deploying to Render

`render.yaml` in the repository root defines everything Render needs: a web service and an
always-on scheduler. Render reads it when you create or sync a Blueprint from the connected repository.

## Why Render

The app needs two long-running processes: the standalone Node server and the 15-second
scheduler that performs five-minute reassignment and outbox delivery. Render runs both as
native Node services. The Render scheduler runs `node scripts/worker.mjs` and calls the
web service's authenticated `/api/jobs/run` endpoint. Salesforce/SMS credentials and enable
flags therefore live on the web service. Other hosting arrangements need an equivalent
persistent scheduler.

## One-time setup

1. Push the repository to GitHub or GitLab. Build output folders are git-ignored; Render
   builds from source on every deploy.
2. In Render: **New → Blueprint**, pick the repository, branch `main`. Render shows the two
   services from `render.yaml`.
3. Enter the `sync: false` values for the web service when prompted:
   - `DATABASE_URL` — the connection string for `samana_qms` as the restricted `qms_app`
     role, printed by `npm run db:app-role` (run once with the owner string).
   - `MIGRATE_DATABASE_URL` — the owner connection string; the pre-deploy migration uses it.
     The same owner string in both is accepted until the role exists.
   - `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` — the
     connected app credentials for the org in use.
     The scheduler copies `WORKER_SECRET` and `DATABASE_URL` from the web service automatically.
4. Apply. Render builds both services, runs `scripts/migrate.mjs` before the web service
   starts, and reports the web URL.
5. If the assigned URL differs from `https://samana-qms.onrender.com`, update `APP_ORIGIN`
   on the web service and `WORKER_ORIGIN` on the scheduler, then redeploy.

Other settings in the Blueprint: `TRUSTED_CLIENT_IP_HEADER=x-forwarded-for` turns on
per-address rate limits using the address Render's proxy appends; `RETENTION_IDENTIFIER_DAYS`
and `RETENTION_EVENT_DAYS` stay empty (keep everything) until a retention period is agreed.

## First run

The database already contains the administrator account if you reuse the existing Neon
database. For an empty database, open the scheduler's shell in Render and run:

```sh
BOOTSTRAP_PASSWORD='<at least 14 characters>' node scripts/bootstrap.mjs
```

Then sign in at the web URL as `admin` and change the password when prompted.

## Verifying

- `https://<web-url>/api/health` returns `{"status":"ready"}`.
- `https://<web-url>/api/health/alerts` returns 200 once the scheduler has ticked; point the
  uptime monitor at this address so a stale scheduler, a failed delivery or a paused Salesforce
  connection pages someone.
- Settings → Connected systems shows Salesforce connected and the scheduler healthy
  within 30 seconds of the worker starting.
- Issue one ticket from the overview page and confirm it appears in the live queue.
- Run `node scripts/security-smoke.mjs https://<web-url>` to check headers and access guards.
- Existing services created manually must use the scheduler start command
  `node scripts/worker.mjs` and build command `npm ci --omit=dev`. Pushing a Blueprint file
  does not reconfigure a manually created service. Confirm both commands in Render.

## Switching to another Salesforce org (UAT, production)

Change the three `SALESFORCE_*` values on the web service and redeploy both services.
Nothing else changes. Keep `SALESFORCE_WRITE_ENABLED` at `false` until the target org has
the `QMS_Ticket__c` object, the two Apex REST classes, and a dedicated integration user with
the `QMS_Access` permission set.

## Operational notes

- Select service plans that support continuous web and worker operation, and review the
  current cost in Render before applying a Blueprint. No service plan is changed by local tests.
- If database network restrictions are enabled, configure them using the actual outbound
  addresses listed for the deployed services.
- Logs for both services are in the Render dashboard. The scheduler logs one JSON line per
  tick; `scheduler_unreachable` means it cannot reach the web URL.
- Rollback: Render keeps previous deploys. Use **Manual Deploy → Rollback** on the web
  service; migrations are additive and do not need reverting.
