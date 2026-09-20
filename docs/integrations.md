# Integration contracts

## Salesforce: read-only by default

The server obtains OAuth tokens using `client_credentials` against `SALESFORCE_INSTANCE_URL`, caches tokens briefly, and retries authentication once after a 401. Credentials never reach the browser. The instance must be HTTPS under `salesforce.com`. Requests have timeouts, bounded pagination, and sanitized errors.

`GET /services/apexrest/api/AccountLookupAPI` accepts exactly one of `mobile`, `emiratesId`, or `passportNumber`. Mobile input is 8–15 digits with country code; EID is `784-XXXX-XXXXXXX-X`; passport input is normalized uppercase. The first `accounts` entry is used as required by the BRD. Salesforce's API does not specify an ordering for duplicate accounts; the app preserves the API's first result.

The supplied API returns account ID/name/email/phone/identifiers and unit IDs/numbers, SB references, and Collection agent/manager names/emails. Supplemental **read-only** Salesforce REST queries retrieve name components, project names, Collection user IDs, and CRM calling-list owner IDs. CRM service owners use the latest calling-list entry for CRM, Resale, or Handover, falling back to CRM. Collection uses `Customer_Unit__c.Collection_Agent__c` and the user's `ManagerId`. A queue-owned calling list cannot identify one preferred person, so service-group fallback applies. Missing project/owner fields remain visibly unavailable; the app does not invent data.

Directory import fetches active standard Salesforce users, manager IDs, and emails. It updates names and manager mappings while preserving existing app privileges. Newly imported users have no password, are disabled, and have no service access. Explicit group sync maps each service to a Salesforce public group/queue and stores the resulting app memberships. Local staff without Salesforce IDs remain under manual control. Group selection is an operational decision because the organization contains many similarly named queues; no mapping is guessed.

The live read-only verification authenticated successfully and retrieved an account with eight units: six contained project names, one had a Collection owner, and none had a user-owned CRM calling-list match. These are source-data gaps on the sampled account, not evidence that all accounts have complete mappings.

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
| `POST /api/customers/lookup` | Authorized staff or customer lookup; customer response is redacted |
| `POST /api/tickets` | Valid lookup + service/unit + unique requestId; atomic idempotent issue |
| `GET /api/queue` | Paginated staff queue; agents see their assigned tickets |
| `GET /api/tickets/:id`, `/print` | Authorized ticket detail or minimal receipt |
| `POST /api/tickets/:id/action` | Call/start/close/no_show/reassign with optimistic `version` |
| `POST /api/presence` | Staff heartbeat and availability |
| `GET /api/public/status/:token` | Minimal ticket status via unguessable private link |
| `GET /api/display` | Authenticated TV: ticket number/service/counter only |
| `GET/POST /api/team` | Managers view; administrators edit |
| `GET /api/reports`, `/audit`, `/integrations` | Manager/HOD/admin reports, audit, health |
| `POST /api/integrations/salesforce/sync` | Administrator directory import |
| `GET/POST /api/integrations/salesforce/groups` | Administrator group selection and service sync |
| `POST /api/jobs/run` | Scheduler bearer credential; routing and outbox tick |

Private ticket status links expire one day after completion. They show no customer identity. Identifying yourself by mobile/EID/passport follows the requested BRD; it is not an OTP-based proof of identity. Customer lookup results disclose only a first name and selectable units/projects and are rate-limited. If stronger identity proof is required, add OTP after choosing the SMS provider.
