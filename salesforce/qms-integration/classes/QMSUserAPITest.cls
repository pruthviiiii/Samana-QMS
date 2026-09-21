@IsTest
private class QMSUserAPITest {

    static void setGetContext(Map<String, String> params) {
        RestRequest req = new RestRequest();
        req.httpMethod = 'GET';
        req.requestURI = '/services/apexrest/api/QMSUserAPI';
        req.addHeader('Content-Type', 'application/json');
        if (params != null) req.params.putAll(params);
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    static QMSUserAPI.ResponseWrapper getResponse() {
        return (QMSUserAPI.ResponseWrapper) JSON.deserialize(
            RestContext.response.responseBody.toString(), QMSUserAPI.ResponseWrapper.class);
    }

    static User createTestUser(String lastName, Id managerId) {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        String unique = 'qmsuserapi' + Math.abs(Crypto.getRandomInteger());
        User u = new User(
            FirstName = 'Qms',
            LastName = lastName,
            Alias = 'qmsu' + String.valueOf(Math.abs(Crypto.getRandomInteger())).left(4),
            Username = unique + '@example.com',
            Email = unique + '@example.com',
            ProfileId = p.Id,
            TimeZoneSidKey = 'Asia/Dubai',
            LocaleSidKey = 'en_US',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            ManagerId = managerId
        );
        insert u;
        return u;
    }

    @IsTest
    static void testPingReportsOk() {
        setGetContext(new Map<String, String>{'ping' => '1'});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(200, response.statusCode);
        System.assertEquals('ok', response.message);
        System.assertEquals(0, response.TotalRecords);
    }

    @IsTest
    static void testMissingQueryRejected() {
        setGetContext(null);

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(false, response.isSuccess);
        System.assertEquals(400, response.statusCode);
    }

    @IsTest
    static void testShortQueryRejected() {
        setGetContext(new Map<String, String>{'q' => 'ab'});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        System.assertEquals(400, getResponse().statusCode);
    }

    @IsTest
    static void testOverlongQueryRejected() {
        setGetContext(new Map<String, String>{'q' => 'x'.repeat(101)});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        System.assertEquals(400, getResponse().statusCode);
    }

    @IsTest
    static void testSearchFindsActiveUserByNameWithManager() {
        User manager = createTestUser('QmsManager' + Math.abs(Crypto.getRandomInteger()), null);
        String lastName = 'QmsAgent' + Math.abs(Crypto.getRandomInteger());
        User agent = createTestUser(lastName, manager.Id);
        setGetContext(new Map<String, String>{'q' => lastName});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(200, response.statusCode);
        System.assertEquals(1, response.TotalRecords);
        QMSUserAPI.UserWrapper found = response.users[0];
        System.assertEquals(agent.Id, found.id);
        System.assertEquals(agent.Username, found.username);
        System.assertEquals(agent.Email, found.email);
        System.assertEquals(manager.Id, found.managerId);
        System.assertEquals(manager.FirstName + ' ' + manager.LastName, found.managerName);
    }

    @IsTest
    static void testSearchByEmailFragment() {
        User agent = createTestUser('QmsEmailAgent' + Math.abs(Crypto.getRandomInteger()), null);
        String fragment = agent.Email.substringBefore('@example.com');
        setGetContext(new Map<String, String>{'q' => fragment});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(1, response.TotalRecords);
        System.assertEquals(agent.Id, response.users[0].id);
    }

    @IsTest
    static void testWildcardsAreNotHonoured() {
        createTestUser('QmsWildcard' + Math.abs(Crypto.getRandomInteger()), null);
        setGetContext(new Map<String, String>{'q' => '%%%'});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        // Wildcards are stripped, leaving nothing searchable: the request must be refused,
        // never widened into a listing of every user.
        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(400, response.statusCode);
        System.assertEquals(0, response.TotalRecords);
    }

    @IsTest
    static void testNoMatchReturnsEmptyList() {
        setGetContext(new Map<String, String>{'q' => 'zzqq-no-such-user-xx'});

        Test.startTest();
        QMSUserAPI.handleGetRequests();
        Test.stopTest();

        QMSUserAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(0, response.TotalRecords);
        System.assertEquals(true, response.users.isEmpty());
    }
}
