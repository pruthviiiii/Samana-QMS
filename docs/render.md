# Deploying to Render

`render.yaml` in the repository root defines everything Render needs: a web service, an
always-on scheduler, and a shared environment variable group. Render reads it when you create
a Blueprint from the connected repository.

## Why Render

The app needs two long-running processes: the standalone Node server and the 15-second
scheduler that performs five-minute reassignment and outbox delivery. Render runs both as
native Node services. Serverless hosts (Vercel, Netlify) cannot run the scheduler and their
cron floor of one minute would violate the five-minute routing rule.

## One-time setup

1. Push the repository to GitHub or GitLab. Build output folders are git-ignored; Render
   builds from source on every deploy.
2. In Render: **New → Blueprint**, pick the repository, branch `main`. Render shows the two
   services and the variable group from `render.yaml`.
3. Enter the `sync: false` values when prompted:
   - `DATABASE_URL` — the Neon connection string for `samana_qms`.
   - `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` — the
     connected app credentials for the org in use.
4. Apply. Render builds both services, runs `scripts/migrate.mjs` before the web service
   starts, and reports the web URL.
5. If the assigned URL differs from `https://samana-qms.onrender.com`, update `APP_ORIGIN`
   on the web service and `WORKER_ORIGIN` on the scheduler, then redeploy.

## First run

The database already contains the administrator account if you reuse the existing Neon
database. For an empty database, open the scheduler's shell in Render and run:

```sh
BOOTSTRAP_PASSWORD='<at least 14 characters>' node scripts/bootstrap.mjs
```

Then sign in at the web URL as `admin` and change the password when prompted.

## Verifying

- `https://<web-url>/api/health` returns `{"status":"ready"}`.
- Settings → Connected systems shows Salesforce connected and the scheduler healthy
  within 30 seconds of the worker starting.
- Issue one ticket from the overview page and confirm it appears in the live queue.

## Switching to another Salesforce org (UAT, production)

Change the three `SALESFORCE_*` values in the `samana-qms-shared` group and redeploy both
services. Nothing else changes. Keep `SALESFORCE_WRITE_ENABLED` at `false` until the
target org has the `QMS_Ticket__c` object, the two Apex REST classes, and a dedicated
integration user with the `QMS_Access` permission set.

## Operational notes

- Both services use the `starter` plan so the scheduler never sleeps. A free web instance
  would sleep after idle and the queue would stop routing.
- Render's outbound IP addresses are dynamic on standard plans, so the Neon IP allow list
  must stay open, or use a Render plan with static outbound IPs.
- Logs for both services are in the Render dashboard. The scheduler logs one JSON line per
  tick; `scheduler_unreachable` means it cannot reach the web URL.
- Rollback: Render keeps previous deploys. Use **Manual Deploy → Rollback** on the web
  service; migrations are additive and do not need reverting.
