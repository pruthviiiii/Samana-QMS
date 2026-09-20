# QMS ticket writeback patch — deployed to POD2

This local Metadata API package contains proposed replacements for `QMSTicketAPI` and `QMSTicketAPITest` only, with API version 62.0. Its baseline is the Salesforce source fetched on **20 September 2026**, saved in `.analysis/current-QMSTicketAPI.cls` and `.analysis/current-QMSTicketAPITest.cls`.

The API now queries `Ticket_Handled_By__c` on existing tickets and clears that current-handler lookup before resolving each complete incoming snapshot. An existing Salesforce User ID in `handledByEmployeeId` takes precedence. If it cannot resolve, `handledByEmail` remains the fallback for legacy `EMP-*` identifiers, ordered by User Id for deterministic results. Both lookups include inactive users for historical snapshots. Assignment history and comments retain their existing behavior.

Three regression tests were added using the existing request/payload helpers:

- Reposting an unassigned waiting ticket succeeds, retains status `New`, and creates no duplicate.
- A valid User ID wins over a conflicting email; a later legacy ID falls back to email deterministically, including inactive users.
- A null current assignment clears the lookup and returns an unstarted ticket to `New`, preserving handler history, reassignment count, and comments.

The existing email-only test now expects the lowest matching User Id, so shared email addresses do not incorrectly require the running user to be selected. All other baseline tests and helpers are retained.

**Approval scope:** validation and eventual replacement of these two Apex classes in the explicitly approved Salesforce org. The package contains no object, field, permission, profile, or data changes. Incoming POSTs must remain complete snapshots: an omitted or unresolved handler now clears the current lookup. Existing start/end timestamps still determine `In Progress`/`Resolved` before assignment status.

**Validation and deployment:** the user approved sandbox changes. Both current org classes matched the reviewed baseline. Validation `0AfWA00000F5SB70AN` and deployment `0AfWA00000F5SCj0AN` succeeded in POD2 on 21 September 2026 using `RunSpecifiedTests`, with all nine `QMSTicketAPITest` methods passing and zero component/test errors. The older account/unit test was repaired to create the Sales Booking now required by its Customer Unit fixture. Tests use rolled-back records; no production org was modified.
