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
| Salesforce NFR | Supplied API plus read-only enrichment and group/directory integration; live lookup verified |
| SMS NFR | Durable HTTPS adapter implemented; provider credentials/contract and delivery acceptance pending |

## Explicit decisions for unspecified cases

- A waiting ticket's age determines the five-minute threshold. The scheduler checks every 15 seconds; actual rerouting can occur up to one interval after the threshold plus execution time.
- A called ticket blocks a second call just as an in-service ticket does. A database unique index prevents two active services per agent.
- An unmapped/offline Collection manager is visible as an exception; the app does not route it to an arbitrary CRM user. An assigned offline manager remains visible for HOD/admin intervention.
- If no available agent exists, the waiting ticket stays durable with a visible routing reason. Automatic routing resumes when eligible staff are online.
- Registered accounts with no units are stopped with a reception message, preserving the requirement that registered tickets identify a unit.
- The per-service sequence resets on the Dubai calendar day. Ticket UUIDs remain globally unique. Numbers above 999 expand instead of truncating.
- Daily counts and dates use Asia/Dubai. Stored timestamps use PostgreSQL timestamptz.
- Managers/HODs can inspect all service queues and reports; agents' queue is restricted to their assignments. Reception can issue and inspect tickets; customer/display roles cannot access staff data.
- TVs show ticket numbers and counters. Customer identity/project/unit is confined to authenticated staff screens; mobile status is minimal.
- English and Arabic are available for check-in. The staff operations interface and announcements are English.
- Group sync reads Salesforce and updates app memberships only. Changing a Salesforce source group or adding Salesforce fields is outside the current authorization.

## Acceptance still requiring the operating environment

Device/browser testing, physical printer behavior, TV audio/fullscreen, the final public HTTPS domain, SMS delivery, staff/group activation, and persistent host/recovery exercises require the launch environment. The repository includes automated backend tests and builds, but these do not replace those acceptance steps.
