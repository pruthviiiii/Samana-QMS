@RestResource(urlMapping='/api/AccountLookupAPI/*')
global without sharing class AccountLookupAPI {

    @HttpGet
    global static void handleGetRequests() {
        ResponseWrapper response = new ResponseWrapper();
        RestResponse res = RestContext.response;

        String mobile = RestContext.request.params.get('mobile');
        String emiratesId = RestContext.request.params.get('emiratesId');
        String passportNumber = RestContext.request.params.get('passportNumber');

        try {
            if (String.isBlank(mobile) && String.isBlank(emiratesId) && String.isBlank(passportNumber)) {
                response.statusCode = 400;
                response.message = 'At least one of mobile, emiratesId, or passportNumber is required.';
            } else {
                List<String> validationErrors = new List<String>();
                if (String.isNotBlank(mobile) && !Pattern.matches('[0-9]{8,15}', mobile)) {
                    validationErrors.add('Invalid mobile number format. Expected 8 to 15 digits.');
                }
                if (String.isNotBlank(emiratesId) && !Pattern.matches('784-[0-9]{4}-[0-9]{7}-[0-9]{1}', emiratesId)) {
                    validationErrors.add('Invalid Emirates ID format. Expected 784-XXXX-XXXXXXX-X.');
                }
                if (String.isNotBlank(passportNumber) && !Pattern.matches('[A-Za-z0-9]{4,20}', passportNumber)) {
                    validationErrors.add('Invalid passport number format. Expected 4 to 20 letters or digits.');
                }
                if (!validationErrors.isEmpty()) {
                    response.statusCode = 400;
                    response.message = String.join(validationErrors, ' ');
                } else {
                    response = searchAccounts(mobile, emiratesId, passportNumber);
                }
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

    private static ResponseWrapper searchAccounts(String mobile, String emiratesId, String passportNumber) {
        List<String> whereClauses = new List<String>();
        Map<String, Object> bindMap = new Map<String, Object>();

        if (String.isNotBlank(mobile)) {
            whereClauses.add('Mobile_Number__c = :mobile');
            bindMap.put('mobile', mobile);
        }
        if (String.isNotBlank(emiratesId)) {
            whereClauses.add('EID_Number__c = :emiratesId');
            bindMap.put('emiratesId', emiratesId);
        }
        if (String.isNotBlank(passportNumber)) {
            whereClauses.add('Passport_Number__c = :passportNumber');
            bindMap.put('passportNumber', passportNumber);
        }

        // SYSTEM_MODE matches the FLS behavior of the other integration REST classes in
        // this org (AgencyAPI, LeadCreationExternalAPI) - access is controlled via the
        // integration Profile's / permission set's classAccesses, not per-field permissions.
        // The QMS integration user therefore needs API access and this class only; every
        // value the QMS routing engine uses is returned here so it runs no SOQL of its own.
        String query = 'SELECT Id, Name, FirstName, MiddleName, LastName, ' +
            'First_Name__c, Middle_Name__c, Last_Name__c, ' +
            'Email_Address__c, Passport_Number__c, EID_Number__c, ' +
            'Mobile_Number__c, Mobile_Country_Code__c FROM Account WHERE ' +
            String.join(whereClauses, ' AND ') + ' LIMIT 50';
        List<Account> accounts = Database.queryWithBinds(query, bindMap, AccessLevel.SYSTEM_MODE);

        Set<Id> accountIds = new Map<Id, Account>(accounts).keySet();
        Map<Id, List<Customer_Unit__c>> unitsByAccountId = getActiveUnitsByAccountId(accountIds);
        Map<Id, List<CallingOwnerWrapper>> ownersByUnitId = getCallingOwnersByUnitId(accountIds);

        ResponseWrapper response = new ResponseWrapper();
        response.isSuccess = true;
        response.statusCode = 200;
        response.message = accounts.isEmpty() ? 'No matching account found.' : 'Account(s) found.';
        response.TotalRecords = accounts.size();
        for (Account acc : accounts) {
            List<Customer_Unit__c> units = unitsByAccountId.get(acc.Id);
            response.accounts.add(new AccountLookupWrapper(
                acc, units == null ? new List<Customer_Unit__c>() : units, ownersByUnitId));
        }
        return response;
    }

    // Sales Booking Reference / Unit Number / construction status all come from the same
    // Customer_Unit__c row (each row ties one owned unit to one sales booking) - same
    // Account__c + Unit_Active__c = 'Yes' pattern already used by CustomerDetailsSrController.
    // Project and Collection Agent identifiers are returned so the caller needs no object access.
    private static Map<Id, List<Customer_Unit__c>> getActiveUnitsByAccountId(Set<Id> accountIds) {
        Map<Id, List<Customer_Unit__c>> result = new Map<Id, List<Customer_Unit__c>>();
        if (accountIds.isEmpty()) {
            return result;
        }
        List<Customer_Unit__c> units = [
            SELECT Id, Name, Account__c, Sales_Booking__r.SB_Number__c, Sales_Booking__r.List_of_Units__c,
                   Inventory__r.Unit_Code__c, Inventory__r.Unit_Name__c,
                   Project__c, Project__r.Name, Project_Name__c,
                   Building__r.Construction_Status__c,
                   Handover_Status__c,
                   Collection_Agent__c, Collection_Agent__r.Name, Collection_Agent__r.Email,
                   Collection_Agent__r.ManagerId, Collection_Agent__r.Manager.Name, Collection_Agent__r.Manager.Email
            FROM Customer_Unit__c
            WHERE Account__c IN :accountIds AND Unit_Active__c = 'Yes'
            WITH SYSTEM_MODE
            ORDER BY Id
            LIMIT 500
        ];
        for (Customer_Unit__c cu : units) {
            if (!result.containsKey(cu.Account__c)) {
                result.put(cu.Account__c, new List<Customer_Unit__c>());
            }
            result.get(cu.Account__c).add(cu);
        }
        return result;
    }

    // Latest Calling_List__c row per unit and department. Only user-owned rows expose an
    // ownerId; queue-owned rows return null so the caller applies its own fallback.
    private static Map<Id, List<CallingOwnerWrapper>> getCallingOwnersByUnitId(Set<Id> accountIds) {
        Map<Id, List<CallingOwnerWrapper>> result = new Map<Id, List<CallingOwnerWrapper>>();
        if (accountIds.isEmpty()) {
            return result;
        }
        List<Calling_List__c> rows = [
            SELECT Customer_Unit__c, OwnerId, Department__c, Collection_Agent_Manager__c, LastModifiedDate
            FROM Calling_List__c
            WHERE Account__c IN :accountIds AND Customer_Unit__c != null
            WITH SYSTEM_MODE
            ORDER BY LastModifiedDate DESC, Id DESC
            LIMIT 1000
        ];
        Set<Id> ownerUserIds = new Set<Id>();
        for (Calling_List__c row : rows) {
            if (row.OwnerId != null && row.OwnerId.getSObjectType() == User.SObjectType) {
                ownerUserIds.add(row.OwnerId);
            }
        }
        Map<Id, User> owners = ownerUserIds.isEmpty()
            ? new Map<Id, User>()
            : new Map<Id, User>([SELECT Id, ManagerId FROM User WHERE Id IN :ownerUserIds WITH SYSTEM_MODE]);
        Set<String> seen = new Set<String>();
        for (Calling_List__c row : rows) {
            String department = row.Department__c == null ? '' : row.Department__c;
            String key = row.Customer_Unit__c + '|' + department;
            if (seen.contains(key)) {
                continue;
            }
            seen.add(key);
            Boolean userOwned = row.OwnerId != null && row.OwnerId.getSObjectType() == User.SObjectType;
            CallingOwnerWrapper owner = new CallingOwnerWrapper();
            owner.department = department;
            owner.ownerId = userOwned ? String.valueOf(row.OwnerId) : null;
            if (row.Collection_Agent_Manager__c != null) {
                owner.ownerManagerId = String.valueOf(row.Collection_Agent_Manager__c);
            } else if (userOwned && owners.containsKey(row.OwnerId) && owners.get(row.OwnerId).ManagerId != null) {
                owner.ownerManagerId = String.valueOf(owners.get(row.OwnerId).ManagerId);
            }
            if (!result.containsKey(row.Customer_Unit__c)) {
                result.put(row.Customer_Unit__c, new List<CallingOwnerWrapper>());
            }
            result.get(row.Customer_Unit__c).add(owner);
        }
        return result;
    }

    global class ResponseWrapper {
        global Boolean isSuccess;
        global Integer statusCode;
        global String message;
        global Integer TotalRecords;
        global List<AccountLookupWrapper> accounts;

        global ResponseWrapper() {
            this.isSuccess = false;
            this.statusCode = 400;
            this.message = '';
            this.TotalRecords = 0;
            this.accounts = new List<AccountLookupWrapper>();
        }
    }

    global class AccountLookupWrapper {
        global String id;
        global String name;
        global String firstName;
        global String middleName;
        global String lastName;
        global String email;
        global String passportNumber;
        global String emiratesId;
        global String phoneNumber;
        global String phoneCountryCode;
        global List<UnitWrapper> units;

        global AccountLookupWrapper(Account acc, List<Customer_Unit__c> customerUnits,
                                    Map<Id, List<CallingOwnerWrapper>> ownersByUnitId) {
            this.id = acc.Id;
            this.name = acc.Name;
            this.firstName = String.isNotBlank(acc.FirstName) ? acc.FirstName : acc.First_Name__c;
            this.middleName = String.isNotBlank(acc.MiddleName) ? acc.MiddleName : acc.Middle_Name__c;
            this.lastName = String.isNotBlank(acc.LastName) ? acc.LastName : acc.Last_Name__c;
            this.email = acc.Email_Address__c;
            this.passportNumber = acc.Passport_Number__c;
            this.emiratesId = acc.EID_Number__c;
            this.phoneNumber = acc.Mobile_Number__c;
            this.phoneCountryCode = acc.Mobile_Country_Code__c;
            this.units = new List<UnitWrapper>();
            for (Customer_Unit__c cu : customerUnits) {
                List<CallingOwnerWrapper> owners = ownersByUnitId.get(cu.Id);
                this.units.add(new UnitWrapper(cu, owners == null ? new List<CallingOwnerWrapper>() : owners));
            }
        }
    }

    global class UnitWrapper {
        global String customerUnitId;
        global String unitNumber;
        global String salesBookingUnitSnapshot;
        global String salesBookingReference;
        global String handoverStatus;
        global Decimal constructionStatus;
        global String projectId;
        global String projectName;
        global String collectionAgentId;
        global String collectionAgentName;
        global String collectionAgentEmail;
        global String collectionAgentManagerId;
        global String collectionAgentManagerName;
        global String collectionAgentManagerEmail;
        global List<CallingOwnerWrapper> callingOwners;

        global UnitWrapper(Customer_Unit__c cu, List<CallingOwnerWrapper> owners) {
            this.customerUnitId = cu.Id;
            if (cu.Inventory__r != null && String.isNotBlank(cu.Inventory__r.Unit_Code__c)) {
                this.unitNumber = cu.Inventory__r.Unit_Code__c;
            } else if (cu.Inventory__r != null && String.isNotBlank(cu.Inventory__r.Unit_Name__c)) {
                this.unitNumber = cu.Inventory__r.Unit_Name__c;
            } else {
                this.unitNumber = cu.Name;
            }
            // Raw snapshot as stored directly on Sales_Booking__c - kept separate from unitNumber
            // since it's free text and can carry stale/unrelated values on some records.
            this.salesBookingUnitSnapshot = cu.Sales_Booking__r != null ? cu.Sales_Booking__r.List_of_Units__c : null;
            this.salesBookingReference = cu.Sales_Booking__r != null ? cu.Sales_Booking__r.SB_Number__c : null;
            this.handoverStatus = cu.Handover_Status__c;
            this.constructionStatus = cu.Building__r != null ? cu.Building__r.Construction_Status__c : null;
            this.projectId = cu.Project__c != null ? String.valueOf(cu.Project__c) : null;
            this.projectName = cu.Project__r != null && String.isNotBlank(cu.Project__r.Name)
                ? cu.Project__r.Name : cu.Project_Name__c;
            this.collectionAgentId = cu.Collection_Agent__c != null ? String.valueOf(cu.Collection_Agent__c) : null;
            this.collectionAgentName = cu.Collection_Agent__r != null ? cu.Collection_Agent__r.Name : null;
            this.collectionAgentEmail = cu.Collection_Agent__r != null ? cu.Collection_Agent__r.Email : null;
            this.collectionAgentManagerId = cu.Collection_Agent__r != null && cu.Collection_Agent__r.ManagerId != null
                ? String.valueOf(cu.Collection_Agent__r.ManagerId) : null;
            this.collectionAgentManagerName = cu.Collection_Agent__r != null && cu.Collection_Agent__r.Manager != null
                ? cu.Collection_Agent__r.Manager.Name : null;
            this.collectionAgentManagerEmail = cu.Collection_Agent__r != null && cu.Collection_Agent__r.Manager != null
                ? cu.Collection_Agent__r.Manager.Email : null;
            this.callingOwners = owners;
        }
    }

    global class CallingOwnerWrapper {
        global String department;
        global String ownerId;
        global String ownerManagerId;
    }
}
