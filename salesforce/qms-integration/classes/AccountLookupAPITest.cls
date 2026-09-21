@IsTest
private class AccountLookupAPITest {

    static void setGetContext(String endpoint, Map<String, String> params) {
        RestRequest req = new RestRequest();
        req.httpMethod = 'GET';
        req.requestURI = endpoint;
        req.addHeader('Content-Type', 'application/json');
        if (params != null) req.params.putAll(params);
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    static Account createTestAccount(String mobile, String emiratesId, String passportNumber) {
        Id personAccountRTId = Schema.SObjectType.Account.getRecordTypeInfosByDeveloperName().get('PersonAccount').getRecordTypeId();
        Account acc = new Account(
            RecordTypeId = personAccountRTId,
            FirstName = 'Lookup',
            LastName = 'LookupTest' + Math.abs(Crypto.getRandomInteger()),
            Status__c = 'Under KYC',
            Email_Address__c = 'lookuptest@example.com',
            Mobile_Number__c = mobile,
            Mobile_Country_Code__c = 'United Arab Emirates: 971',
            EID_Number__c = emiratesId,
            Passport_Number__c = passportNumber,
            Nationality__c = 'Afghanistan'
        );
        insert acc;
        return acc;
    }

    // Users are setup objects: create them inside System.runAs to avoid mixed DML
    // with the customer data inserted afterwards in the same test.
    static User createTestUser(String suffix, Id managerId) {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        String unique = 'alapi' + suffix + Math.abs(Crypto.getRandomInteger());
        User u = new User(
            FirstName = 'Lookup',
            LastName = 'Agent ' + suffix,
            Alias = ('al' + suffix).left(8),
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

    static AccountLookupAPI.ResponseWrapper getResponse() {
        return (AccountLookupAPI.ResponseWrapper) JSON.deserialize(
            RestContext.response.responseBody.toString(), AccountLookupAPI.ResponseWrapper.class);
    }

    @IsTest
    static void testSearchByMobileOnly() {
        createTestAccount('501234567', null, null);
        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'mobile' => '501234567'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(200, response.statusCode);
        System.assertEquals(1, response.TotalRecords);
        AccountLookupAPI.AccountLookupWrapper account = response.accounts[0];
        System.assertEquals('lookuptest@example.com', account.email);
        System.assertEquals('501234567', account.phoneNumber);
        System.assertEquals('United Arab Emirates: 971', account.phoneCountryCode);
        System.assertEquals('Lookup', account.firstName);
        System.assert(account.lastName.startsWith('LookupTest'));
        System.assertEquals(true, account.units.isEmpty());
    }

    @IsTest
    static void testSearchIncludesUnitSalesBookingAndConstructionStatus() {
        Account acc = createTestAccount('501234599', '784-1234-1234567-1', 'ZT123456');

        Project__c project = new Project__c(
            Name = 'AccountLookupAPI Test Project',
            Master_Developer__c = 'Business Bay LLC',
            Project_Code__c = 'ALAPI' + Math.abs(Crypto.getRandomInteger()),
            Country__c = 'Oman'
        );
        insert project;

        Building__c building = new Building__c(Name = 'AccountLookupAPI Test Building', Project__c = project.Id);
        insert building;
        building.Construction_Status__c = 72.5;
        update building;

        Inventory__c inventory = new Inventory__c(
            Project__c = project.Id,
            Building__c = building.Id,
            Unit_Name__c = 'Test Unit ALAPI',
            Unit_Code__c = 'ALAPI-UNIT-001',
            Approval_Status__c = 'Approved'
        );
        insert inventory;

        Sales_Booking__c sb = new Sales_Booking__c(
            Account__c = acc.Id,
            Project__c = project.Id,
            List_of_Units__c = 'ALAPI-UNIT-001'
        );
        insert sb;
        sb = [SELECT Id, Name, SB_Number__c, List_of_Units__c FROM Sales_Booking__c WHERE Id = :sb.Id];

        // Unit_Active__c is a formula (based on Status__c) - leaving Status__c blank
        // evaluates it to 'Yes', matching the endpoint's active-unit filter.
        Customer_Unit__c cu = new Customer_Unit__c(
            Account__c = acc.Id,
            Project__c = project.Id,
            Building__c = building.Id,
            Inventory__c = inventory.Id,
            Sales_Booking__c = sb.Id
        );
        insert cu;

        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'mobile' => '501234599'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(1, response.TotalRecords);
        AccountLookupAPI.AccountLookupWrapper account = response.accounts[0];
        System.assertEquals('ZT123456', account.passportNumber);
        System.assertEquals('784-1234-1234567-1', account.emiratesId);
        System.assertEquals(1, account.units.size());
        AccountLookupAPI.UnitWrapper unit = account.units[0];
        System.assertEquals('ALAPI-UNIT-001', unit.unitNumber);
        System.assertEquals(sb.SB_Number__c, unit.salesBookingReference);
        System.assertEquals(sb.List_of_Units__c, unit.salesBookingUnitSnapshot);
        System.assertEquals(72.5, unit.constructionStatus);
        System.assertEquals(project.Id, unit.projectId);
        System.assertEquals('AccountLookupAPI Test Project', unit.projectName);
        System.assertEquals(null, unit.collectionAgentId);
        System.assertEquals(true, unit.callingOwners.isEmpty());
    }

    @IsTest
    static void testReturnsProjectCollectionAgentAndCallingOwners() {
        User manager;
        User collectionAgent;
        User crmOwner;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            manager = createTestUser('mgr', null);
            collectionAgent = createTestUser('col', manager.Id);
            crmOwner = createTestUser('crm', manager.Id);
        }

        Account acc = createTestAccount('501234588', null, null);
        Project__c project = new Project__c(
            Name = 'ALAPI Owners Project',
            Master_Developer__c = 'Business Bay LLC',
            Project_Code__c = 'ALAPIO' + Math.abs(Crypto.getRandomInteger()),
            Country__c = 'Oman'
        );
        insert project;
        Building__c building = new Building__c(Name = 'ALAPI Owners Building', Project__c = project.Id);
        insert building;
        Inventory__c inventory = new Inventory__c(
            Project__c = project.Id,
            Building__c = building.Id,
            Unit_Name__c = 'ALAPI Owners Unit',
            Unit_Code__c = 'ALAPI-OWN-001',
            Approval_Status__c = 'Approved'
        );
        insert inventory;
        Sales_Booking__c sb = new Sales_Booking__c(Account__c = acc.Id, Project__c = project.Id, List_of_Units__c = 'ALAPI-OWN-001');
        insert sb;
        Customer_Unit__c cu = new Customer_Unit__c(
            Account__c = acc.Id,
            Project__c = project.Id,
            Building__c = building.Id,
            Inventory__c = inventory.Id,
            Sales_Booking__c = sb.Id,
            Collection_Agent__c = collectionAgent.Id
        );
        insert cu;

        // Two CRM rows: the one created last must win as the current calling owner.
        insert new Calling_List__c(Account__c = acc.Id, Customer_Unit__c = cu.Id, Department__c = 'CRM', OwnerId = manager.Id);
        insert new Calling_List__c(Account__c = acc.Id, Customer_Unit__c = cu.Id, Department__c = 'CRM', OwnerId = crmOwner.Id);
        // Resale row with an explicit manager overrides the owner's own manager.
        insert new Calling_List__c(Account__c = acc.Id, Customer_Unit__c = cu.Id, Department__c = 'Resale',
            OwnerId = collectionAgent.Id, Collection_Agent_Manager__c = manager.Id);

        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'mobile' => '501234588'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(1, response.TotalRecords);
        AccountLookupAPI.UnitWrapper unit = response.accounts[0].units[0];
        System.assertEquals('ALAPI Owners Project', unit.projectName);
        System.assertEquals(collectionAgent.Id, unit.collectionAgentId);
        System.assertEquals(manager.Id, unit.collectionAgentManagerId);
        System.assertEquals(2, unit.callingOwners.size());

        Map<String, AccountLookupAPI.CallingOwnerWrapper> byDepartment = new Map<String, AccountLookupAPI.CallingOwnerWrapper>();
        for (AccountLookupAPI.CallingOwnerWrapper owner : unit.callingOwners) {
            byDepartment.put(owner.department, owner);
        }
        System.assertEquals(crmOwner.Id, byDepartment.get('CRM').ownerId, 'latest CRM row wins');
        System.assertEquals(manager.Id, byDepartment.get('CRM').ownerManagerId, 'manager resolved from the owner user');
        System.assertEquals(collectionAgent.Id, byDepartment.get('Resale').ownerId);
        System.assertEquals(manager.Id, byDepartment.get('Resale').ownerManagerId, 'explicit manager field wins');
    }

    @IsTest
    static void testSearchByEmiratesIdOnly() {
        createTestAccount(null, '784-1234-1234567-1', null);
        setGetContext('/services/apexrest/api/AccountLookupAPI',
            new Map<String, String>{'emiratesId' => '784-1234-1234567-1'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(1, response.TotalRecords);
    }

    @IsTest
    static void testSearchByMobileAndEmiratesId_MatchesSameAccount() {
        createTestAccount('501234567', '784-1234-1234567-1', null);
        setGetContext('/services/apexrest/api/AccountLookupAPI',
            new Map<String, String>{'mobile' => '501234567', 'emiratesId' => '784-1234-1234567-1'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        System.assertEquals(1, getResponse().TotalRecords);
    }

    @IsTest
    static void testSearchByMobileAndEmiratesId_MismatchReturnsNoResults() {
        createTestAccount('501234567', '784-1234-1234567-1', null);
        // Same mobile, but an Emirates ID that belongs to no one - AND logic means no match.
        setGetContext('/services/apexrest/api/AccountLookupAPI',
            new Map<String, String>{'mobile' => '501234567', 'emiratesId' => '784-9999-9999999-9'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(true, response.isSuccess);
        System.assertEquals(200, response.statusCode);
        System.assertEquals(0, response.TotalRecords);
    }

    @IsTest
    static void testNoParamsProvided() {
        setGetContext('/services/apexrest/api/AccountLookupAPI', null);

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        AccountLookupAPI.ResponseWrapper response = getResponse();
        System.assertEquals(false, response.isSuccess);
        System.assertEquals(400, response.statusCode);
    }

    @IsTest
    static void testInvalidMobileFormat() {
        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'mobile' => 'abc'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        System.assert(RestContext.response.responseBody.toString().contains('Invalid mobile number format'));
    }

    @IsTest
    static void testInvalidEmiratesIdFormat() {
        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'emiratesId' => '784-12-3-4'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        System.assert(RestContext.response.responseBody.toString().contains('Invalid Emirates ID format'));
    }

    @IsTest
    static void testInvalidPassportFormat() {
        setGetContext('/services/apexrest/api/AccountLookupAPI', new Map<String, String>{'passportNumber' => 'A1'});

        Test.startTest();
        AccountLookupAPI.handleGetRequests();
        Test.stopTest();

        System.assert(RestContext.response.responseBody.toString().contains('Invalid passport number format'));
    }
}
