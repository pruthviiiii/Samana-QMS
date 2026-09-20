# Security and code review — 21 September 2026

Scope: QMS source, isolated PostgreSQL integration tests, production Node build, dependency audit, and low-volume unauthenticated checks against `https://samana-qms.onrender.com`. This is a targeted engineering review, not a comprehensive penetration test or certification.

## Fixes

| Finding | Correction |
| --- | --- |
| A login verified before a password reset could insert a session after revocation. | Migration 009 serializes session issuance, password changes, and administrator resets on the user row, rechecking the verified password hash. |
| Logout failed while an executive owned a called/in-service ticket. | Revoke the session first, retain ticket ownership, and make presence cleanup independent. |
| Rotating usernames bypassed login throttling; username/email aliases had independent budgets. | Add a sitewide cap, optional trusted-client cap, and one shared budget per resolved account before password hashing. |
| Mixed-case duplicate usernames could select an arbitrary account; valid long emails could not sign in. | Reject ambiguous matches, preserve unique username priority, and accept email-length identifiers. |
| Existing QR sessions consumed admission capacity. | Reuse valid sessions before charging admission limits; bound new admissions separately. |
| Render HTML omitted browser security headers. | Apply runtime middleware for CSP, frame denial, MIME protection, no-referrer, permissions restrictions, and HSTS on HTTPS deployments. |
| Hidden paths fell through to the HTML application. | Reject hidden path segments, including encoded dots and backslashes. The earlier `/.env` response was HTML; no environment-file disclosure was observed. |
| PostgreSQL Date values produced missing Salesforce durations; incomplete provider responses could be treated as delivered. | Accept Date/string timestamps and require confirmed success, status code, and Salesforce record ID. |
| Render Blueprint started a direct worker without matching integration configuration. | Start the authenticated HTTP scheduler, using the web service's integration settings. Reject redirects and invalid endpoint responses. Docker/local direct-worker support remains available. |
| Salesforce group errors left the UI displaying a permanent loading message. | Explicit loading/error states, disabled duplicate refreshes, and clean retries. |

## Validation

- 102 app/database tests passed; four additional isolated scheduler tests passed.
- TypeScript, lint, Node production build, worker build, and dependency audit are release checks.
- Dependency audit returned zero known vulnerabilities; the configured-secret scan found none in tracked source.
- The local production server passed 25 HTTP smoke checks. The HTTPS target adds an HSTS check.
- Regression tests exercise concurrent password changes/logins, logout revocation, alias limits, ambiguous users, authorization, request validation, queue transitions, privacy, CSV safety, and outbox retries.
- Salesforce validation passed all nine `QMSTicketAPITest` methods, including the three new assignment/replay regressions. The older unit fixture now creates its required Sales Booking relationship.

## Deployment and remaining operational work

Apply migration 009 before starting the new web build; it has been applied to the connected app and test databases. Deploy web and scheduler from the reviewed commit. Manually created Render workers need the commands documented in [Render setup](render.md); changing `render.yaml` alone does not update those services.

Set `TRUSTED_CLIENT_IP_HEADER` only after confirming the hosting proxy overwrites that header. Shared caps remain active without it. CSP permits inline hydration scripts required by the current framework; this is not a nonce-based CSP. Rate limiting is not a substitute for edge DDoS protection.

Authenticated browser/device acceptance, backup restore, load testing, SMS-provider configuration, production Salesforce selection, and database least-privilege roles remain rollout work. Existing credentials shared in conversation should be rotated through the Salesforce connected-app and hosting secret settings in a coordinated change. No secrets are included in this report.

Run `node scripts/security-smoke.mjs https://samana-qms.onrender.com` after deployment. This check does not log in, issue tickets, look up customers, or run the scheduler.
