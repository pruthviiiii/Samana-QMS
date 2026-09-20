@RestResource(urlMapping='/api/QMSTicketAPI/*')
global without sharing class QMSTicketAPI {

    @HttpPost
    global static void handlePostRequest() {
        ResponseWrapper response = new ResponseWrapper();
        RestResponse res = RestContext.response;

        try {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(RestContext.request.requestBody.toString());
            String ticketNumber = (String) body.get('qmsTicketNumber');

            if (String.isBlank(ticketNumber)) {
                response.statusCode = 400;
                response.message = 'qmsTicketNumber is required.';
            } else {
                response = upsertTicket(ticketNumber, body);
            }
        } catch (Exception e) {
            response.isSuccess = false;
            response.statusCode = 500;
            response.message = 'An unexpected error occurred: ' + e.getMessage();
        }

        res.statusCode = response.statusCode;
        res.addHeader('Content-Type', 'application/json');
        res.responseBody = Blob.valueOf(JSON.serializePretty(response));
    }

    // Upserts on External_Ticket_Number__c so the source system can POST the same
    // ticket multiple times as it progresses (created -> assigned -> resolved) without
    // creating duplicates. SYSTEM_MODE matches the FLS behavior of the other integration
    // REST classes in this org (AccountLookupAPI, AgencyAPI) - access is controlled via
    // the integration Profile's/permission set's classAccesses, not per-field permissions.
    private static ResponseWrapper upsertTicket(String ticketNumber, Map<String, Object> body) {
        ResponseWrapper response = new ResponseWrapper();

        List<QMS_Ticket__c> existingTickets = [
            SELECT Id, Resolution_Remarks_by_Agent__c, Assigned_Employees__c, Number_of_Reassignments__c,
                   Ticket_Handled_By__c
            FROM QMS_Ticket__c
            WHERE External_Ticket_Number__c = :ticketNumber
            WITH SYSTEM_MODE
            LIMIT 1
        ];

        Boolean isNewTicket = existingTickets.isEmpty();
        QMS_Ticket__c ticket = isNewTicket ? new QMS_Ticket__c() : existingTickets[0];

        ticket.External_Ticket_Number__c = ticketNumber;
        ticket.Ticket_Origin__c = (String) body.get('recordType');
        ticket.Is_Guest__c = toBoolean(body.get('isGuest'));
        ticket.Customer_Name__c = (String) body.get('customerName');
        ticket.Customer_Mobile__c = (String) body.get('customerMobile');
        ticket.Customer_Email__c = (String) body.get('customerEmail');
        ticket.Emirates_Id__c = (String) body.get('emiratesId');
        ticket.Passport_Number__c = (String) body.get('passportNumber');
        ticket.Unit_Number__c = (String) body.get('unitNumber');
        ticket.Sales_Booking_Reference__c = (String) body.get('salesBookingReference');
        ticket.Department__c = (String) body.get('department');
        ticket.Reason_Code__c = (String) body.get('reason');
        ticket.Request_Type__c = (String) body.get('reasonLabel');
        ticket.Queue_Id__c = (String) body.get('queueId');
        ticket.Handled_By_Employee_Id__c = (String) body.get('handledByEmployeeId');
        ticket.Meeting_Room__c = (String) body.get('meetingRoom');
        ticket.Outcome__c = (String) body.get('outcome');
        ticket.Waiting_Seconds__c = toInteger(body.get('waitingSeconds'));
        ticket.Service_Seconds__c = toInteger(body.get('serviceSeconds'));
        ticket.Queued_At__c = parseDateTime((String) body.get('createdAt'));
        ticket.Start_Time__c = parseDateTime((String) body.get('serviceStartedAt'));
        ticket.End_Time__c = parseDateTime((String) body.get('completedAt'));

        String accountId = (String) body.get('accountId');
        Boolean hasValidAccountId = String.isNotBlank(accountId) && isValidId(accountId, Account.SObjectType);
        if (hasValidAccountId) {
            ticket.Account__c = accountId;
        }

        // Each POST is the current snapshot. A missing or unresolved handler clears
        // the current lookup, while applyAssignment preserves assignment history.
        ticket.Ticket_Handled_By__c = null;
        String handledByEmployeeId = (String) body.get('handledByEmployeeId');
        if (String.isNotBlank(handledByEmployeeId) && isValidId(handledByEmployeeId, User.SObjectType)) {
            Id handlerId = Id.valueOf(handledByEmployeeId);
            List<User> handlers = [
                SELECT Id FROM User WHERE Id = :handlerId WITH SYSTEM_MODE LIMIT 1
            ];
            if (!handlers.isEmpty()) {
                ticket.Ticket_Handled_By__c = handlers[0].Id;
            }
        }

        // Legacy EMP-* identifiers still resolve by email. Include inactive users
        // for historical snapshots and choose consistently when emails are shared.
        String handledByEmail = (String) body.get('handledByEmail');
        if (ticket.Ticket_Handled_By__c == null && String.isNotBlank(handledByEmail)) {
            List<User> handlers = [
                SELECT Id FROM User WHERE Email = :handledByEmail
                WITH SYSTEM_MODE ORDER BY Id LIMIT 1
            ];
            if (!handlers.isEmpty()) {
                ticket.Ticket_Handled_By__c = handlers[0].Id;
            }
        }

        String unitNumber = (String) body.get('unitNumber');
        if (hasValidAccountId && String.isNotBlank(unitNumber)) {
            List<Customer_Unit__c> units = [
                SELECT Id FROM Customer_Unit__c
                WHERE Account__c = :accountId AND Inventory__r.Unit_Code__c = :unitNumber
                WITH SYSTEM_MODE
                LIMIT 1
            ];
            if (!units.isEmpty()) {
                ticket.Customer_Unit__c = units[0].Id;
            }
        }

        applyAssignment(ticket, (String) body.get('handledByName'));
        appendComments(ticket, body);
        ticket.Status__c = determineStatus(ticket);

        Database.UpsertResult ur = Database.upsert(ticket, QMS_Ticket__c.External_Ticket_Number__c, false);
        if (ur.isSuccess()) {
            response.isSuccess = true;
            response.statusCode = 200;
            response.message = 'Ticket ' + (isNewTicket ? 'created' : 'updated') + ' successfully.';
            response.recordId = ur.getId();
        } else {
            response.isSuccess = false;
            response.statusCode = 400;
            response.message = ur.getErrors().isEmpty() ? 'Unknown error saving ticket.' : ur.getErrors()[0].getMessage();
        }
        return response;
    }

    // Assigned_Employees__c keeps every handler this ticket has had (comma separated);
    // Number_of_Reassignments__c only increments when the handler actually changes, so
    // re-posting the same payload for the same handler stays idempotent.
    private static void applyAssignment(QMS_Ticket__c ticket, String handledByName) {
        if (String.isBlank(handledByName)) {
            return;
        }
        if (String.isBlank(ticket.Assigned_Employees__c)) {
            ticket.Assigned_Employees__c = handledByName;
        } else if (!ticket.Assigned_Employees__c.endsWith(handledByName)) {
            ticket.Assigned_Employees__c += ', ' + handledByName;
            ticket.Number_of_Reassignments__c = (ticket.Number_of_Reassignments__c == null ? 0 : ticket.Number_of_Reassignments__c) + 1;
        }
    }

    // Comments have no dedicated object (concatenated into the existing Resolution
    // Remarks field per business decision) - each line is checked against what is
    // already stored so re-posting the same comment on a later call does not duplicate it.
    private static void appendComments(QMS_Ticket__c ticket, Map<String, Object> body) {
        Object commentsValue = body.get('comments');
        if (!(commentsValue instanceof List<Object>)) {
            return;
        }
        String remarks = ticket.Resolution_Remarks_by_Agent__c;
        for (Object rawComment : (List<Object>) commentsValue) {
            if (!(rawComment instanceof Map<String, Object>)) {
                continue;
            }
            Map<String, Object> comment = (Map<String, Object>) rawComment;
            String commentBody = (String) comment.get('body');
            if (String.isBlank(commentBody)) {
                continue;
            }
            String byName = (String) comment.get('byName');
            DateTime at = parseDateTime((String) comment.get('at'));
            String line = '[' + (at == null ? '' : at.format('yyyy-MM-dd HH:mm')) + '] ' + byName + ': ' + commentBody;
            if (String.isBlank(remarks)) {
                remarks = line;
            } else if (!remarks.contains(line)) {
                remarks += '\n' + line;
            }
        }
        ticket.Resolution_Remarks_by_Agent__c = remarks;
    }

    private static String determineStatus(QMS_Ticket__c ticket) {
        if (ticket.End_Time__c != null) {
            return 'Resolved';
        }
        if (ticket.Start_Time__c != null) {
            return 'In Progress';
        }
        if (ticket.Ticket_Handled_By__c != null) {
            return 'Assigned';
        }
        return 'New';
    }

    private static Boolean isValidId(String value, Schema.SObjectType expectedType) {
        try {
            return Id.valueOf(value).getSObjectType() == expectedType;
        } catch (Exception e) {
            return false;
        }
    }

    // JSON.deserialize's own ISO-8601 parser handles the incoming "...Z" format
    // correctly without a bespoke wrapper class - see comments below for values.
    private static DateTime parseDateTime(String isoValue) {
        if (String.isBlank(isoValue)) {
            return null;
        }
        try {
            return (DateTime) JSON.deserialize('"' + isoValue + '"', DateTime.class);
        } catch (Exception e) {
            return null;
        }
    }

    private static Boolean toBoolean(Object value) {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        return Boolean.valueOf(String.valueOf(value));
    }

    // Untyped JSON numbers can surface as Decimal, Double, or Long depending on shape,
    // so every case is handled explicitly rather than assuming one boxed type.
    private static Integer toInteger(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Integer) {
            return (Integer) value;
        }
        if (value instanceof Decimal) {
            return ((Decimal) value).intValue();
        }
        if (value instanceof Double) {
            return ((Double) value).intValue();
        }
        if (value instanceof Long) {
            return ((Long) value).intValue();
        }
        try {
            return Integer.valueOf(String.valueOf(value));
        } catch (Exception e) {
            return null;
        }
    }

    global class ResponseWrapper {
        global Boolean isSuccess;
        global Integer statusCode;
        global String message;
        global String recordId;

        global ResponseWrapper() {
            this.isSuccess = false;
            this.statusCode = 400;
            this.message = '';
        }
    }
}
