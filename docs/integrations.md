# Integration contracts

## Salesforce: Apex REST only

The server obtains OAuth tokens using `client_credentials` against `SALESFORCE_INSTANCE_URL`, caches tokens briefly, and retries authentication once after a 401. Credentials never reach the browser. The instance must be HTTPS under `salesforce.com`. Requests have timeouts, bounded sizes, and sanitized errors.

Every Salesforce call goes to an Apex REST class under `/services/apexrest/api/`. The app runs no SOQL and never calls `/services/data`; `tests/apex-only.test.ts` fails the build if such a call is introduced. The integration user therefore needs only **API Enabled** and class access to `AccountLookupAPI`, `QMSUserAPI` and `QMSTicketAPI`. The classes run in system mode, so no object or field permissions are required. The package for the Salesforce team is in `salesforce/qms-integration/`.

`GET /services/apexrest/api/AccountLookupAPI` accepts exactly one of `mobile`, `emiratesId`, or `passportNumber`. Mobile input is 8–15 digits with country code; EID is `784-XXXX-XXXXXXX-X`; passport input is normalized uppercase. The first `accounts` entry is used as required by the BRD. Per account the class returns identifiers, first/middle/last names and active units; per unit it returns `projectName`, `collectionAgentId`, `collectionAgentManagerId` and `callingOwners` (latest `Calling_List__c` row per department with `ownerId` and `ownerManagerId`). CRM services use the CRM, Resale or Handover owner with CRM as fallback; Collection uses the unit's collection agent and that agent's manager. Ids that are not Salesforce user ids are ignored. Missing project or owner fields remain visibly unavailable; the app does not invent data.

`GET /services/apexrest/api/QMSUserAPI?q=<text>` searches active standard users by name, username or email (3–100 characters, at most 20 results). The Team page calls it only when an administrator types a search; nothing is imported in bulk and only members the administrator saves exist in the app. `?ping=1` is the health probe. Until the class is deployed the app reports user search as unavailable and everything else keeps working.

Queues (service membership) are managed in the app and stored in PostgreSQL only. Nothing about queues is read from or written to Salesforce.

## Optional Salesforce ticket upsert

`POST /services/apexrest/api/QMSTicketAPI` is guarded by `SALESFORCE_WRITE_ENABLED=true`. POD2 writeback and the two-class Apex repair were explicitly approved. The repair deployed on 21 September 2026 with nine Apex tests passing. Changes to other Salesforce metadata or orgs still require approval.

`lib/jobs.ts` builds full snapshots using the Apex contract: external ticket number `SAMANA-<UUID>`, record type, guest flag, account/contact identifiers, department/reason, unit/SB, handled-by identity/email, meeting room, outcome, timing, timestamps, and comments. The daily visible ticket number is not used as the external ID. The repaired API resolves a valid Salesforce User ID first, then email as a legacy fallback, and clears an absent assignment. No Salesforce schema change was required. Delivery requires `isSuccess:true`, `statusCode:200`, and a valid `recordId`.

## SMS gateway

The application implements an HTTPS JSON gateway adapter, not an assumed vendor-specific endpoint. Configure a provider or a small provider adapter with:

```http
POST SMS_GATEWAY_URL
Authorization: Bearer SMS_GATEWAY_TOKEN
Content-Type: application/json
Idempotency-Key: <outbox UUID>
```

```json
{"to":"971501234567","sender":"SAMANA","message":"Ticket details and private tracking link","idempotencyKey":"<outbox UUID>"}
```

Expected successful response: HTTP 2xx with JSON such as `{"success":true,"id":"provider-reference"}`. `success:false`, non-2xx, timeout, redirect, or malformed JSON causes retry. The provider must deduplicate the idempotency key; the app cannot guarantee exactly-once SMS delivery across an ambiguous network failure without provider support. No SMS has been sent during development.

Only registered customers who entered a mobile number are eligible. EID/passport entries never enqueue SMS. Jobs are attempted up to five times with exponential backoff. Disabled integrations are visible in the ticket details; they do not prevent ticket issuance. Once configured, previously disabled eligible jobs become pending, so review the backlog before enabling messaging.

## App endpoints

All responses containing application data use `Cache-Control: no-store`. State-changing browser requests require an exact allowed Origin and an HttpOnly SameSite session cookie. The scheduler has a separate bearer credential.

| Endpoint | Access / purpose |
|---|---|
| `GET /api/health` | Database readiness; no customer details |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/password`, `POST /api/auth/logout` | Staff authentication and session lifecycle |
| `GET /api/checkin-link` | Reception/manager/display rotating QR invite |
| `POST /api/public/session` | Valid invite creates short-lived customer session |
| `POST /api/customers/lookup` | Authorized staff or customer lookup; customer response is redacted. Staff may send `walkIn: true` when Salesforce is unreachable to register a General Query visit without a lookup (audited as `degraded`) |
| `POST /api/tickets` | Valid lookup + service/unit + unique requestId; atomic idempotent issue |
| `GET /api/queue` | Paginated staff queue; agents see their assigned tickets |
| `GET /api/tickets/:id`, `/print` | Authorized ticket detail or minimal receipt |
| `POST /api/tickets/:id/action` | Call/start/close/no_show/reassign with optimistic `version` |
| `POST /api/presence` | Staff heartbeat and availability |
| `GET /api/public/status/:token` | Minimal ticket status via unguessable private link |
| `GET /api/display` | Authenticated TV: ticket number/service/counter only |
| `GET/POST /api/team` | Managers view; administrators edit |
| `GET /api/queues`, `POST /api/queues/members` | Admin, HOD and manager queue membership; stored in PostgreSQL only, never sent to Salesforce |
| `GET /api/reports`, `/audit`, `/integrations` | Manager/HOD/admin reports, audit, health |
| `GET /api/integrations/salesforce/users?q=` | Administrator on-demand Salesforce user search (Apex `QMSUserAPI`) |
| `POST /api/jobs/run` | Scheduler bearer credential; routing and outbox tick |

Private ticket status links expire one day after completion. They show no customer identity. Identifying yourself by mobile/EID/passport follows the requested BRD; it is not an OTP-based proof of identity. Customer lookup results disclose only a first name and selectable units/projects and are rate-limited. If stronger identity proof is required, add OTP after choosing the SMS provider.
