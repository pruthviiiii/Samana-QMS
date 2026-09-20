@IsTest
private class QMSTicketAPITest {

    static void setPostContext(String endpoint, Map<String, Object> body) {
        RestRequest req = new RestRequest();
        req.httpMethod = 'POST';
        req.requestURI = endpoint;
        req.addHeader('Content-Type', 'application/json');
        req.requestBody = Blob.valueOf(JSON.serialize(body));
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    static QMSTicketAPI.ResponseWrapper getResponse() {
        return (QMSTicketAPI.ResponseWrapper) JSON.deserialize(
            RestContext.response.responseBody.toString(), QMSTicketAPI.ResponseWrapper.class);
    }

    static Map<String, Object> basePayload(String ticketNumber, String handledByName) {
        return new Map<String, Object>{
            'qmsTicketNumber' => ticketNumber,
            'recordType' => 'Walk-in Customer',
            'isGuest' => false,
            'customerName' => 'Omar Al Mansoori',
            'customerMobile' => '+971501234567',
            'customerEmail' => 'omar@domain.com',
            'emiratesId' => '784-1985-4102387-1',
            'passportNumber' => 'N0348122',
            'department' => 'CRM',
            'reason' => 'REFUND',
            'reasonLabel' => 'Refund',
            'queueId' => 'Q_REFUND',
            'handledByEmployeeId' => 'EMP-006',
            'handledByName' => handledByName,
            'createdAt' => '2026-09-15T13:14:12Z',
            'serviceStartedAt' => '2026-09-15T13:14:12Z',
            'completedAt' => '2026-09-15T13:14:13Z',
            'waitingSeconds' => 0,
            'serviceSeconds' => 1,
            'comments' => new List<Object>{
                new Map<String, Object>{
                    'by' => 'EMP-006',
                    'byName' => handledByName,
                    'at' => '2026-09-15T13:14:13Z',
                    'body' => 'Refund approved and processed.'
                }
            }
        };
    }

    @IsTest
    static void testCreateNewTicket() {
        setPostContext('/services/apexrest/api/QMSTicketAPI', basePayload('QMS-2026-0001', 'Prakash'));

        Test.startTest();
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMSTicketAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(200, response.statusCode);
        System.assertNotEquals(null, response.recordId);

        QMS_Ticket__c ticket = [
            SELECT Request_Type__c, Reason_Code__c, Ticket_Origin__c, Customer_Name__c, Customer_Email__c,
                   Assigned_Employees__c, Number_of_Reassignments__c, Status__c, Resolution_Remarks_by_Agent__c,
                   Waiting_Seconds__c, Service_Seconds__c, Start_Time__c, End_Time__c
            FROM QMS_Ticket__c
            WHERE External_Ticket_Number__c = 'QMS-2026-0001'
        ];
        System.assertEquals('Refund', ticket.Request_Type__c);
        System.assertEquals('REFUND', ticket.Reason_Code__c);
        System.assertEquals('Walk-in Customer', ticket.Ticket_Origin__c);
        System.assertEquals('Omar Al Mansoori', ticket.Customer_Name__c);
        System.assertEquals('Prakash', ticket.Assigned_Employees__c);
        System.assertEquals(null, ticket.Number_of_Reassignments__c);
        System.assertEquals('Resolved', ticket.Status__c);
        System.assert(ticket.Resolution_Remarks_by_Agent__c.contains('Refund approved and processed.'));
        System.assertEquals(0, ticket.Waiting_Seconds__c);
        System.assertEquals(1, ticket.Service_Seconds__c);
        System.assertNotEquals(null, ticket.Start_Time__c);
        System.assertNotEquals(null, ticket.End_Time__c);
    }

    @IsTest
    static void testMissingTicketNumberReturns400() {
        Map<String, Object> payload = basePayload(null, 'Prakash');
        payload.remove('qmsTicketNumber');
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);

        Test.startTest();
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMSTicketAPI.ResponseWrapper response = getResponse();
        System.assertEquals(false, response.isSuccess);
        System.assertEquals(400, response.statusCode);
    }

    @IsTest
    static void testReassignmentIncrementsCountAndAppendsHistory() {
        setPostContext('/services/apexrest/api/QMSTicketAPI', basePayload('QMS-2026-0002', 'Prakash'));
        Test.startTest();
        QMSTicketAPI.handlePostRequest();

        Map<String, Object> secondCall = basePayload('QMS-2026-0002', 'Fatima');
        secondCall.put('comments', new List<Object>());
        setPostContext('/services/apexrest/api/QMSTicketAPI', secondCall);
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMS_Ticket__c ticket = [
            SELECT Assigned_Employees__c, Number_of_Reassignments__c
            FROM QMS_Ticket__c
            WHERE External_Ticket_Number__c = 'QMS-2026-0002'
        ];
        System.assertEquals('Prakash, Fatima', ticket.Assigned_Employees__c);
        System.assertEquals(1, ticket.Number_of_Reassignments__c);
    }

    @IsTest
    static void testRepostingSameHandlerAndCommentIsIdempotent() {
        Map<String, Object> payload = basePayload('QMS-2026-0003', 'Prakash');
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
        Test.startTest();
        QMSTicketAPI.handlePostRequest();

        setPostContext('/services/apexrest/api/QMSTicketAPI', basePayload('QMS-2026-0003', 'Prakash'));
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMS_Ticket__c ticket = [
            SELECT Assigned_Employees__c, Number_of_Reassignments__c, Resolution_Remarks_by_Agent__c
            FROM QMS_Ticket__c
            WHERE External_Ticket_Number__c = 'QMS-2026-0003'
        ];
        System.assertEquals('Prakash', ticket.Assigned_Employees__c);
        System.assertEquals(null, ticket.Number_of_Reassignments__c);
        Integer occurrences = ticket.Resolution_Remarks_by_Agent__c.countMatches('Refund approved and processed.');
        System.assertEquals(1, occurrences);
    }

    @IsTest
    static void testHandledByEmailResolvesDeterministically() {
        User runningUser = [SELECT Id, Email FROM User WHERE Id = :UserInfo.getUserId()];
        User expectedHandler = [SELECT Id FROM User WHERE Email = :runningUser.Email ORDER BY Id LIMIT 1];
        Map<String, Object> payload = basePayload('QMS-2026-0004', 'Prakash');
        payload.put('handledByEmail', runningUser.Email);
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);

        Test.startTest();
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMS_Ticket__c ticket = [
            SELECT Ticket_Handled_By__c FROM QMS_Ticket__c WHERE External_Ticket_Number__c = 'QMS-2026-0004'
        ];
        System.assertEquals(expectedHandler.Id, ticket.Ticket_Handled_By__c);
    }

    @IsTest
    static void testWaitingUnassignedReplayIsIdempotent() {
        Map<String, Object> payload = basePayload('QMS-2026-0006', null);
        payload.put('handledByEmployeeId', null);
        payload.put('handledByEmail', null);
        payload.put('serviceStartedAt', null);
        payload.put('completedAt', null);
        payload.put('serviceSeconds', null);
        payload.put('waitingSeconds', 120);
        payload.put('comments', new List<Object>());

        Test.startTest();
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
        QMSTicketAPI.handlePostRequest();
        QMSTicketAPI.ResponseWrapper firstResponse = getResponse();
        System.assertEquals(true, firstResponse.isSuccess, firstResponse.message);
        System.assertEquals(200, RestContext.response.statusCode);

        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
        QMSTicketAPI.handlePostRequest();
        QMSTicketAPI.ResponseWrapper replayResponse = getResponse();
        Test.stopTest();

        System.assertEquals(true, replayResponse.isSuccess, replayResponse.message);
        System.assertEquals(200, RestContext.response.statusCode);
        System.assertEquals(firstResponse.recordId, replayResponse.recordId);
        List<QMS_Ticket__c> tickets = [
            SELECT Id, Status__c, Ticket_Handled_By__c, Assigned_Employees__c,
                   Number_of_Reassignments__c, Start_Time__c, End_Time__c, Waiting_Seconds__c
            FROM QMS_Ticket__c WHERE External_Ticket_Number__c = 'QMS-2026-0006'
        ];
        System.assertEquals(1, tickets.size());
        System.assertEquals('New', tickets[0].Status__c);
        System.assertEquals(null, tickets[0].Ticket_Handled_By__c);
        System.assertEquals(null, tickets[0].Assigned_Employees__c);
        System.assertEquals(null, tickets[0].Number_of_Reassignments__c);
        System.assertEquals(null, tickets[0].Start_Time__c);
        System.assertEquals(null, tickets[0].End_Time__c);
        System.assertEquals(120, tickets[0].Waiting_Seconds__c);
    }

    @IsTest
    static void testUserIdPrecedesEmailAndLegacyIdFallsBack() {
        User runningUser = [SELECT Id, ProfileId FROM User WHERE Id = :UserInfo.getUserId()];
        String uniqueSuffix = UserInfo.getOrganizationId() + '.' + DateTime.now().getTime()
            + '.' + String.valueOf(Crypto.getRandomInteger());
        String sharedEmail = 'qms-handler.' + uniqueSuffix + '@example.invalid';
        List<User> emailHandlers = new List<User>();
        for (Integer i = 0; i < 2; i++) {
            emailHandlers.add(new User(
                Alias = 'qmsh' + i,
                Email = sharedEmail,
                EmailEncodingKey = 'UTF-8',
                LastName = 'QMS Email Handler ' + i,
                LanguageLocaleKey = 'en_US',
                LocaleSidKey = 'en_US',
                ProfileId = runningUser.ProfileId,
                TimeZoneSidKey = 'Asia/Dubai',
                Username = 'qms' + i + '.' + uniqueSuffix + '@example.invalid',
                IsActive = false
            ));
        }
        insert emailHandlers;
        User expectedEmailHandler = [
            SELECT Id, IsActive FROM User WHERE Email = :sharedEmail ORDER BY Id LIMIT 1
        ];
        System.assertEquals(false, expectedEmailHandler.IsActive);

        // Keep setup User DML separate from QMS DML in this test.
        System.runAs(runningUser) {
            Map<String, Object> payload = basePayload('QMS-2026-0007', 'Preferred Handler');
            payload.put('handledByEmployeeId', String.valueOf(runningUser.Id));
            payload.put('handledByEmail', sharedEmail);
            payload.put('serviceStartedAt', null);
            payload.put('completedAt', null);
            payload.put('comments', new List<Object>());

            Test.startTest();
            setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
            QMSTicketAPI.handlePostRequest();
            QMSTicketAPI.ResponseWrapper firstResponse = getResponse();
            System.assertEquals(true, firstResponse.isSuccess, firstResponse.message);
            QMS_Ticket__c assignedById = [
                SELECT Ticket_Handled_By__c, Status__c FROM QMS_Ticket__c
                WHERE External_Ticket_Number__c = 'QMS-2026-0007'
            ];
            System.assertEquals(runningUser.Id, assignedById.Ticket_Handled_By__c,
                'An existing User ID must take precedence over a different user email.');
            System.assertEquals('Assigned', assignedById.Status__c);

            payload.put('handledByEmployeeId', 'EMP-006');
            payload.put('handledByName', 'Legacy Handler');
            setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
            QMSTicketAPI.handlePostRequest();
            QMSTicketAPI.ResponseWrapper fallbackResponse = getResponse();
            Test.stopTest();

            System.assertEquals(true, fallbackResponse.isSuccess, fallbackResponse.message);
            System.assertEquals(firstResponse.recordId, fallbackResponse.recordId);
            QMS_Ticket__c assignedByEmail = [
                SELECT Ticket_Handled_By__c, Handled_By_Employee_Id__c, Status__c,
                       Assigned_Employees__c, Number_of_Reassignments__c
                FROM QMS_Ticket__c WHERE External_Ticket_Number__c = 'QMS-2026-0007'
            ];
            System.assertEquals(expectedEmailHandler.Id, assignedByEmail.Ticket_Handled_By__c,
                'Legacy IDs must fall back by email, include inactive users, and order by Id.');
            System.assertEquals('EMP-006', assignedByEmail.Handled_By_Employee_Id__c);
            System.assertEquals('Assigned', assignedByEmail.Status__c);
            System.assertEquals('Preferred Handler, Legacy Handler', assignedByEmail.Assigned_Employees__c);
            System.assertEquals(1, assignedByEmail.Number_of_Reassignments__c);
        }
    }

    @IsTest
    static void testNullAssignmentClearsLookupAndPreservesHistory() {
        Map<String, Object> payload = basePayload('QMS-2026-0008', 'Prakash');
        payload.put('handledByEmployeeId', String.valueOf(UserInfo.getUserId()));
        payload.put('serviceStartedAt', null);
        payload.put('completedAt', null);

        Test.startTest();
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
        QMSTicketAPI.handlePostRequest();
        QMSTicketAPI.ResponseWrapper firstResponse = getResponse();
        System.assertEquals(true, firstResponse.isSuccess, firstResponse.message);
        QMS_Ticket__c beforeClear = [
            SELECT Ticket_Handled_By__c, Status__c, Assigned_Employees__c,
                   Number_of_Reassignments__c, Resolution_Remarks_by_Agent__c
            FROM QMS_Ticket__c WHERE External_Ticket_Number__c = 'QMS-2026-0008'
        ];
        System.assertEquals(UserInfo.getUserId(), beforeClear.Ticket_Handled_By__c);
        System.assertEquals('Assigned', beforeClear.Status__c);

        payload.put('handledByEmployeeId', null);
        payload.put('handledByEmail', null);
        payload.put('handledByName', null);
        payload.put('comments', new List<Object>());
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);
        QMSTicketAPI.handlePostRequest();
        QMSTicketAPI.ResponseWrapper clearedResponse = getResponse();
        Test.stopTest();

        System.assertEquals(true, clearedResponse.isSuccess, clearedResponse.message);
        System.assertEquals(firstResponse.recordId, clearedResponse.recordId);
        QMS_Ticket__c afterClear = [
            SELECT Ticket_Handled_By__c, Handled_By_Employee_Id__c, Status__c,
                   Assigned_Employees__c, Number_of_Reassignments__c, Resolution_Remarks_by_Agent__c
            FROM QMS_Ticket__c WHERE External_Ticket_Number__c = 'QMS-2026-0008'
        ];
        System.assertEquals(null, afterClear.Ticket_Handled_By__c);
        System.assertEquals(null, afterClear.Handled_By_Employee_Id__c);
        System.assertEquals('New', afterClear.Status__c);
        System.assertEquals('Prakash', afterClear.Assigned_Employees__c);
        System.assertEquals(beforeClear.Number_of_Reassignments__c, afterClear.Number_of_Reassignments__c);
        System.assertEquals(beforeClear.Resolution_Remarks_by_Agent__c, afterClear.Resolution_Remarks_by_Agent__c);
    }

    @IsTest
    static void testAccountAndUnitLookupResolution() {
        Id personAccountRTId = Schema.SObjectType.Account.getRecordTypeInfosByDeveloperName().get('PersonAccount').getRecordTypeId();
        Account acc = new Account(RecordTypeId = personAccountRTId, LastName = 'QMSTicketAPITest');
        insert acc;

        Project__c project = new Project__c(
            Name = 'QMSTicketAPI Test Project',
            Master_Developer__c = 'Business Bay LLC',
            Project_Code__c = 'QMSAPI' + Math.abs(Crypto.getRandomInteger()),
            Country__c = 'Oman'
        );
        insert project;

        Building__c building = new Building__c(Name = 'QMSTicketAPI Test Building', Project__c = project.Id);
        insert building;

        Inventory__c inventory = new Inventory__c(
            Project__c = project.Id,
            Building__c = building.Id,
            Unit_Name__c = 'Test Unit QMSAPI',
            Unit_Code__c = 'UOT-31-3102A',
            Approval_Status__c = 'Approved'
        );
        insert inventory;

        Sales_Booking__c booking = new Sales_Booking__c(
            Account__c = acc.Id,
            Project__c = project.Id
        );
        insert booking;

        Customer_Unit__c cu = new Customer_Unit__c(
            Account__c = acc.Id,
            Sales_Booking__c = booking.Id,
            Project__c = project.Id,
            Building__c = building.Id,
            Inventory__c = inventory.Id
        );
        insert cu;

        Map<String, Object> payload = basePayload('QMS-2026-0005', 'Prakash');
        payload.put('accountId', acc.Id);
        payload.put('unitNumber', 'UOT-31-3102A');
        setPostContext('/services/apexrest/api/QMSTicketAPI', payload);

        Test.startTest();
        QMSTicketAPI.handlePostRequest();
        Test.stopTest();

        QMS_Ticket__c ticket = [
            SELECT Account__c, Customer_Unit__c, Unit_Number__c
            FROM QMS_Ticket__c
            WHERE External_Ticket_Number__c = 'QMS-2026-0005'
        ];
        System.assertEquals(acc.Id, ticket.Account__c);
        System.assertEquals(cu.Id, ticket.Customer_Unit__c);
        System.assertEquals('UOT-31-3102A', ticket.Unit_Number__c);
    }
}
