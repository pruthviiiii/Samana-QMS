@RestResource(urlMapping='/api/QMSUserAPI/*')
global without sharing class QMSUserAPI {

    // GET ?ping=1            -> {"isSuccess":true,"statusCode":200,"message":"ok"}; the QMS health probe.
    // GET ?q=<3..100 chars>  -> up to 20 active standard users whose name, username or email contains q.
    // There is deliberately no parameterless listing: the QMS adds staff one at a time.
    @HttpGet
    global static void handleGetRequests() {
        ResponseWrapper response = new ResponseWrapper();
        RestResponse res = RestContext.response;
        try {
            Map<String, String> params = RestContext.request.params;
            if (params.containsKey('ping')) {
                response.isSuccess = true;
                response.statusCode = 200;
                response.message = 'ok';
            } else {
                String q = params.get('q');
                if (String.isBlank(q) || q.trim().length() < 3) {
                    response.statusCode = 400;
                    response.message = 'q must be at least 3 characters.';
                } else if (q.trim().length() > 100) {
                    response.statusCode = 400;
                    response.message = 'q must be at most 100 characters.';
                } else {
                    response = searchUsers(q.trim());
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

    private static ResponseWrapper searchUsers(String q) {
        // Strip LIKE wildcards so the caller cannot widen the search; a term that is
        // too short after stripping is refused rather than matching every user.
        String term = q.replaceAll('[%_]', '').trim();
        if (term.length() < 3) {
            ResponseWrapper refused = new ResponseWrapper();
            refused.statusCode = 400;
            refused.message = 'q must contain at least 3 searchable characters.';
            return refused;
        }
        String key = '%' + term + '%';
        List<User> users = [
            SELECT Id, Name, Username, Email, ManagerId, Manager.Name
            FROM User
            WHERE IsActive = true AND UserType = 'Standard'
              AND (Name LIKE :key OR Username LIKE :key OR Email LIKE :key)
            WITH SYSTEM_MODE
            ORDER BY Name
            LIMIT 20
        ];
        ResponseWrapper response = new ResponseWrapper();
        response.isSuccess = true;
        response.statusCode = 200;
        response.message = users.isEmpty() ? 'No matching user found.' : 'User(s) found.';
        response.TotalRecords = users.size();
        for (User u : users) {
            response.users.add(new UserWrapper(u));
        }
        return response;
    }

    global class ResponseWrapper {
        global Boolean isSuccess;
        global Integer statusCode;
        global String message;
        global Integer TotalRecords;
        global List<UserWrapper> users;

        global ResponseWrapper() {
            this.isSuccess = false;
            this.statusCode = 400;
            this.message = '';
            this.TotalRecords = 0;
            this.users = new List<UserWrapper>();
        }
    }

    global class UserWrapper {
        global String id;
        global String name;
        global String username;
        global String email;
        global String managerId;
        global String managerName;

        global UserWrapper(User u) {
            this.id = u.Id;
            this.name = u.Name;
            this.username = u.Username;
            this.email = u.Email;
            this.managerId = u.ManagerId != null ? String.valueOf(u.ManagerId) : null;
            this.managerName = u.Manager != null ? u.Manager.Name : null;
        }
    }
}
