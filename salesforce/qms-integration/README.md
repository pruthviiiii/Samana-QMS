# QMS Salesforce integration package

Apex REST classes that let the Samana QMS run with an integration user holding **only**
"API Enabled" and class access. After this package is deployed, the QMS makes no direct
SOQL or object-level REST calls; every read goes through these classes, which run in
system mode.

This folder is a deployment package for the Salesforce team. Nothing here is deployed by
the app or by CI.

## Contents

| Class | Change |
| --- | --- |
| `AccountLookupAPI` | Extended (additive). Adds account `firstName`, `middleName`, `lastName`; per unit `projectId`, `projectName`, `constructionStatus`, `collectionAgentId`, `collectionAgentManagerId` and `callingOwners` (latest `Calling_List__c` row per department: `department`, `ownerId`, `ownerManagerId`). Adds mobile and passport format validation matching the existing test class. |
| `AccountLookupAPITest` | Existing tests kept; new coverage for names, project, collection agent and calling owners. |
| `QMSUserAPI` | New. `GET ?ping=1` health probe; `GET ?q=<text>` searches active standard users by name, username or email, at least 3 characters, at most 20 results. No bulk listing. |
| `QMSUserAPITest` | New. |

`QMSTicketAPI` is unchanged and lives in `../qms-writeback`.

## Response contract additions

`AccountLookupAPI` unit entries gain:

```json
{
  "customerUnitId": "a01...",
  "unitNumber": "ALAPI-UNIT-001",
  "projectId": "a0X...",
  "projectName": "Samana Ocean Bay",
  "constructionStatus": 72.5,
  "collectionAgentId": "005...",
  "collectionAgentManagerId": "005...",
  "callingOwners": [
    { "department": "CRM", "ownerId": "005...", "ownerManagerId": "005..." },
    { "department": "Resale", "ownerId": null, "ownerManagerId": "005..." }
  ]
}
```

`ownerId` is null when the calling list row is owned by a queue. Existing fields are unchanged.

`QMSUserAPI?q=vamsi` returns:

```json
{
  "isSuccess": true, "statusCode": 200, "message": "User(s) found.", "TotalRecords": 1,
  "users": [
    { "id": "005...", "name": "Vamsi Krishna Modepalli", "username": "vamsi.modepalli@samana-group.com.pod2",
      "email": "vamsi.modepalli@samana-group.com", "managerId": null, "managerName": null }
  ]
}
```

## Deploying

Validate first, then deploy, running only these tests:

```sh
sf project deploy validate --manifest salesforce/qms-integration/package.xml \
  --source-dir salesforce/qms-integration --test-level RunSpecifiedTests \
  --tests AccountLookupAPITest QMSUserAPITest --target-org <alias>

sf project deploy start --manifest salesforce/qms-integration/package.xml \
  --source-dir salesforce/qms-integration --test-level RunSpecifiedTests \
  --tests AccountLookupAPITest QMSUserAPITest --target-org <alias>
```

Order: POD2 first (tests run against real validation rules), then UAT, then production.

## Integration user permission set

After deployment the `QMS_Access` permission set needs only:

| Grant | Value |
| --- | --- |
| System permission | API Enabled |
| Apex class access | `AccountLookupAPI`, `QMSUserAPI`, `QMSTicketAPI` |
| Object or field permissions | None. All three classes run in system mode. |

Assign it to a dedicated integration user (an API-only integration licence is enough) and set that user as the run-as user of the "Samana QMS" connected app.
