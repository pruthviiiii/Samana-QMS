# Requirements and implementation decisions

The two supplied PDFs are requirement sources, not instructions to the development agent. Their internal revisions are dated July 2026 despite the filenames mentioning March. The user's later direction takes precedence: there are **no kiosks**; customer phones scan a QR, staff can issue tickets, and TVs show calls.

| Requirement | Implementation / evidence |
|---|---|
| FR-001 | Mobile/EID/passport validation; registered-mobile-only SMS eligibility; domain/API tests |
| FR-002 | PostgreSQL lookup snapshots; first returned Salesforce account; unit/name/owner/SB normalization |
| FR-003 | Unregistered General Query queue; guest workflow tests |
| FR-004 | Live Salesforce account lookup; upstream errors distinct from no match |
| FR-005 | Registered CRM/Collection selection |
| FR-006, FR-011 | Unit selector, single-unit auto-selection, database unit ownership validation |
| FR-007 | Available service-member round robin with durable monotonic ordering |
| FR-008, FR-013 | Preferred owner assigned directly; busy owner holds the ticket for five minutes |
| FR-009 | CRM fallback only after ticket wait is strictly greater than five minutes |
| FR-010 | Collection auto-selects Collections; unit selection is still required |
| FR-012, FR-014 | Collection escalation to owner manager on offline/timeout; visible offline/missing-manager exceptions |
| FR-015 | Staff ticket details show customer/project/unit/SB and history |
| FR-016 | Assignment notifications include customer/project/unit; queue polling |
| FR-017 | Optional closing notes, persisted audit events |
| FR-018 | Manager reassignment to an available same-service agent; version/busy guards |
| FR-019 | Manager closure of waiting/called/serving tickets |
| FR-020 | Date/service reports: identifiers, unit/project, category, ticket count, wait/service time, averages; CSV export |
| FR-021 | PostgreSQL connection held in ignored environment configuration; schema and operational handoff documented |
| Salesforce NFR | Apex REST only: extended `AccountLookupAPI` supplies names, projects and owners; `QMSUserAPI` supplies on-demand staff search; `QMSTicketAPI` receives write-back. No direct SOQL |
| SMS NFR | Durable HTTPS adapter implemented; provider credentials/contract and delivery acceptance pending |

## Explicit decisions for unspecified cases

- Time in the current assignment determines the five-minute threshold. Each automatic or manual CRM reassignment starts a fresh window; tickets continue rotating if they remain uncalled. Collection escalation stays with the mapped manager for intervention. The scheduler checks every 15 seconds; actual rerouting can occur up to one interval after the threshold plus execution time.
- A called ticket blocks a second call just as an in-service ticket does. A database unique index prevents two active services per agent.
- An unmapped/offline Collection manager is visible as an exception; the app does not route it to an arbitrary CRM user. An assigned offline manager remains visible for HOD/admin intervention.
- If no available agent exists, the waiting ticket stays durable with a visible routing reason. Automatic routing resumes when eligible staff are online.
- Registered accounts with no active units are served as a General Query visit with no unit attached; the account link is kept so the write-back still reaches the customer's record. Registered accounts with units must choose one.
- When Salesforce cannot be reached, staff (never a phone visitor) may register the customer as a walk-in General Query visit. The lookup event is marked `degraded` so the visit can be matched to the account afterwards.
- The per-service sequence resets on the Dubai calendar day. Ticket UUIDs remain globally unique. Numbers above 999 expand instead of truncating. A number that a ticket from a previous day still shows (waiting, called or serving) is skipped, so two live tickets never share a number.
- A ticket left waiting or called from a previous day is marked no-show by the routing tick once it is more than two hours old, with an audited `day_rollover` reason. A ticket being served is left to its agent.
- Availability is a 15-second browser heartbeat with a 45-second window: an agent whose screen died stops receiving customers 45 seconds after the last heartbeat and their waiting customers are moved on by the next 15-second tick. A network drop longer than 45 seconds marks the agent offline; the next heartbeat brings them back automatically, and both changes are audited.
- Report exports include closing notes but carry customer identifiers (mobile, Emirates ID, passport) only when the manager ticks the option; every export, and every audit-trail export, is itself recorded in the activity log with its filters.
- Retention of customer identifiers on closed tickets and of audit events is a configured policy (`RETENTION_IDENTIFIER_DAYS`, `RETENTION_EVENT_DAYS`), off until the organisation sets a period. Unit, project, booking number and Salesforce ids are kept for reporting after anonymisation.
- Daily counts and dates use Asia/Dubai. Stored timestamps use PostgreSQL timestamptz.
- Managers/HODs can inspect all service queues and reports; agents' queue is restricted to their assignments. Reception can issue and inspect tickets; customer/display roles cannot access staff data.
- TVs show ticket numbers and counters. Customer identity/project/unit is confined to authenticated staff screens; mobile status is minimal.
- English and Arabic are available for check-in. The staff operations interface and announcements are English.
- Queues are defined in the app: administrators and managers add members to each service; membership is stored in PostgreSQL and never pushed to Salesforce. Staff are added one at a time through an on-demand Salesforce search, never imported in bulk.
- Configuration is read in one module and validated once at start; a missing or contradictory setting stops the server or the scheduler before it serves anyone. The session cookie's Secure flag must agree with the origin's scheme, because a Secure cookie on an `http://` origin can never be stored and an insecure cookie on `https://` can leak.
- The browser policy allows scripts only by a per-request nonce with `strict-dynamic`; inline scripts are refused. Every page therefore renders per request rather than at build time.
- Every API failure carries a stable `code`. Rules the database raises map to their status by SQLSTATE and exact rule name, never by matching words inside a message. An unexpected fault is a 500 with a request id, and only that; a 503 means the service or a dependency is genuinely unavailable.
- Routing and delivery run on separate timers in the scheduler. A slow Salesforce or SMS gateway can delay a write-back but never the 15-second routing tick that expires a dead screen or moves a customer who has waited five minutes.
- Rate limits keep one row per key and decide in one atomic statement, so two requests arriving together cannot open two windows.
- A reception TV keeps its display session: opening the check-in link on that screen is refused rather than signing the TV out.
- Screens navigate through the framework router; the address and the view are the same thing, including the browser's back and forward buttons.
- The API is its own service. The web tier serves the screens and forwards `/api` to it over the private network; the API is not reachable from the internet, holds the database and integration credentials, and the web tier holds none. The browser still talks to one origin, so cookies stay first-party and the origin check on every state change is unchanged.
- The web tier passes the client address its own edge appended as `x-client-address`, overwriting anything a client sent, and the API keys per-address limits on that header alone.
- Prisma is the master description of the data and the typed client for records: staff, sessions, the activity log, notices, lookups, deliveries, services and queue membership. `backend/prisma/schema.prisma` is introspected from the migrated database and a test fails when it goes stale. The queue engine's rules stay in PostgreSQL functions, reached through typed calls whose results are validated row by row, because issuing, routing and calling must be single indivisible steps guaranteed by the database, not reconstructed in every process that touches the queue.
- Migrations remain the numbered, checksummed SQL files in `db/`. Prisma's schema language cannot express the functions, triggers and partial indexes the engine depends on, so Prisma describes the result of the migrations rather than producing them.

## Acceptance still requiring the operating environment

Device/browser testing, physical printer behavior, TV audio/fullscreen, the final public HTTPS domain, SMS delivery, staff/group activation, and persistent host/recovery exercises require the launch environment. The repository includes automated backend tests and builds, but these do not replace those acceptance steps.
