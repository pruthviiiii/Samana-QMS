import { beforeAll, describe, it } from 'vitest';
import { query } from '../lib/db';
beforeAll(() => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Workflow tests require the isolated test database.');
});
async function check(body: string) {
  await query(`DO $test$
DECLARE actor uuid; a uuid; b uuid; manager uuid; lookup uuid; lookup2 uuid; t jsonb; t2 jsonb; r uuid:=gen_random_uuid(); snapshot jsonb; v integer; chosen uuid; before_a bigint; before_b bigint;
BEGIN
 BEGIN
  PERFORM pg_advisory_xact_lock(1947301);
  UPDATE qms.users SET online=false;
  INSERT INTO qms.users(username,name,role,services,must_change_password) VALUES('fixture-admin-'||r,'Test Manager','admin',ARRAY['crm-general','collection','general'],false) RETURNING id INTO actor;
  INSERT INTO qms.users(username,name,role,sf_id,services,online,last_seen,created_at,must_change_password) VALUES('fixture-a-'||r,'Agent A','agent','sf-a-'||r,ARRAY['crm-general','collection','general'],true,now(),now()-interval '2 seconds',false) RETURNING id INTO a;
  INSERT INTO qms.users(username,name,role,sf_id,services,online,last_seen,created_at,must_change_password) VALUES('fixture-b-'||r,'Agent B','agent','sf-b-'||r,ARRAY['crm-general','collection','general'],true,now(),now()-interval '1 second',false) RETURNING id INTO b;
  INSERT INTO qms.users(username,name,role,sf_id,services,online,last_seen,must_change_password) VALUES('fixture-m-'||r,'Collection Manager','manager','sf-m-'||r,ARRAY['collection'],false,now(),false) RETURNING id INTO manager;
  snapshot:=jsonb_build_object('registered',true,'salesforceId','account-'||r,'name','Synthetic Customer','mobile','971500000111','units',jsonb_build_array(jsonb_build_object('id','unit-1','name','101','project','Test Project','bookingNumber','SB-TEST','ownerId','sf-a-'||r,'managerId','sf-m-'||r)));
  INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES(actor,'mobile','lookup-'||r,snapshot) RETURNING id INTO lookup;
  ${body}
  RAISE EXCEPTION USING ERRCODE='Z9999',MESSAGE='ROLLBACK_SUCCESSFUL_FIXTURE';
 EXCEPTION WHEN SQLSTATE 'Z9999' THEN NULL;
 END;
END $test$`);
}
describe('PostgreSQL workflow invariants', () => {
  it('routes an available unit owner directly', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF t->>'assigned_to' IS DISTINCT FROM a::text OR t->>'routing_reason' IS DISTINCT FROM 'preferred_owner' THEN RAISE EXCEPTION 'Owner not selected';END IF;`,
    ));
  it('round-robins within mapped available agents when owner offline', () =>
    check(
      `UPDATE qms.users SET online=false WHERE id=a;t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF t->>'assigned_to' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'Available fallback not chosen';END IF;`,
    ));
  it('retains a ticket exactly at five minutes, then reroutes after five minutes', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);UPDATE qms.tickets SET created_at=now()-interval '5 minutes',assigned_at=now()-interval '5 minutes' WHERE id=(t->>'id')::uuid;PERFORM qms.route_ticket((t->>'id')::uuid);SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'Rerouted at exact boundary';END IF;UPDATE qms.tickets SET created_at=now()-interval '5 minutes 0.001 seconds',assigned_at=now()-interval '5 minutes 0.001 seconds' WHERE id=(t->>'id')::uuid;PERFORM qms.route_ticket((t->>'id')::uuid);SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;IF chosen IS DISTINCT FROM b THEN RAISE EXCEPTION 'Did not reroute beyond boundary';END IF;`,
    ));
  it('keeps a busy preferred owner on the five-minute hold', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);t:=qms.ticket_action((t->>'id')::uuid,'call',a,(t->>'version')::int);t:=qms.ticket_action((t->>'id')::uuid,'start',a,(t->>'version')::int);snapshot:=jsonb_set(snapshot,'{salesforceId}',to_jsonb('second-'||r));INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES(actor,'mobile','second-'||r,snapshot) RETURNING id INTO lookup2;t2:=qms.issue_ticket(lookup2,'crm-general','unit-1',gen_random_uuid(),actor);IF t2->>'assigned_to' IS DISTINCT FROM a::text OR t2->>'routing_reason' IS DISTINCT FROM 'owner_busy_five_minute_hold' THEN RAISE EXCEPTION 'Busy owner hold missing';END IF;`,
    ));
  it('escalates Collection to the exact selected unit owner manager', () =>
    check(
      `UPDATE qms.users SET online=false WHERE id=a;t:=qms.issue_ticket(lookup,'collection','unit-1',r,actor);IF t->>'assigned_to' IS DISTINCT FROM manager::text OR t->>'routing_reason' IS DISTINCT FROM 'manager_offline_attention_required' THEN RAISE EXCEPTION 'Wrong manager escalation';END IF;`,
    ));
  it('keeps missing-manager tickets visible and unassigned', () =>
    check(
      `UPDATE qms.users SET online=false WHERE id=a;UPDATE qms.lookups SET customer=jsonb_set(customer,'{units,0,managerId}','null'::jsonb) WHERE id=lookup;t:=qms.issue_ticket(lookup,'collection','unit-1',r,actor);IF t->>'assigned_to' IS NOT NULL OR t->>'routing_reason' IS DISTINCT FROM 'manager_mapping_missing' THEN RAISE EXCEPTION 'Missing manager ticket lost';END IF;`,
    ));
  it('does not lose an escalated Collection ticket when its recipient is disabled', () =>
    check(
      `UPDATE qms.users SET online=false WHERE id=a;t:=qms.issue_ticket(lookup,'collection','unit-1',r,actor);UPDATE qms.users SET enabled=false WHERE id=manager;PERFORM qms.route_ticket((t->>'id')::uuid);SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;IF chosen IS NOT NULL THEN RAISE EXCEPTION 'Disabled manager still assigned';END IF;`,
    ));
  it('is idempotent and rejects a changed idempotency payload', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);t2:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF t->>'id' IS DISTINCT FROM t2->>'id' THEN RAISE EXCEPTION 'Duplicate idempotent ticket';END IF;BEGIN PERFORM qms.issue_ticket(lookup,'collection','unit-1',r,actor);RAISE EXCEPTION 'EXPECTED_IDEMPOTENCY_CONFLICT';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'IDEMPOTENCY_CONFLICT' THEN RAISE;END IF;END;`,
    ));
  it('keeps ticket numbers unique and untruncated above 999', () =>
    check(
      `INSERT INTO qms.counters(day,service_id,value) VALUES((now() AT TIME ZONE 'Asia/Dubai')::date,'crm-general',999) ON CONFLICT(day,service_id) DO UPDATE SET value=999;t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF t->>'number' IS DISTINCT FROM 'C-1000' THEN RAISE EXCEPTION 'Ticket number truncated';END IF;`,
    ));
  it('rejects a fabricated unit on guest issuance', () =>
    check(
      `UPDATE qms.lookups SET customer='{"registered":false,"name":"Guest","units":[]}'::jsonb WHERE id=lookup;BEGIN PERFORM qms.issue_ticket(lookup,'general','fabricated',r,actor);RAISE EXCEPTION 'EXPECTED_UNIT_NOT_ALLOWED';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'UNIT_NOT_ALLOWED' THEN RAISE;END IF;END;`,
    ));
  it('prevents duplicate active visits across distinct request IDs', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);BEGIN PERFORM qms.issue_ticket(lookup,'crm-general','unit-1',gen_random_uuid(),actor);RAISE EXCEPTION 'EXPECTED_DUPLICATE_VISIT';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'DUPLICATE_VISIT' THEN RAISE;END IF;END;`,
    ));
  it('never sends SMS for an EID identifier even with a stored mobile', () =>
    check(
      `UPDATE qms.lookups SET identifier_type='emiratesId' WHERE id=lookup;t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF EXISTS(SELECT 1 FROM qms.outbox WHERE ticket_id=(t->>'id')::uuid AND kind='sms') THEN RAISE EXCEPTION 'SMS generated for EID';END IF;`,
    ));
  it('creates a durable SMS outbox for a registered mobile', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);IF NOT EXISTS(SELECT 1 FROM qms.outbox WHERE ticket_id=(t->>'id')::uuid AND kind='sms') THEN RAISE EXCEPTION 'SMS outbox missing';END IF;`,
    ));
  it('rejects stale versions and out-of-service agents', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);BEGIN PERFORM qms.ticket_action((t->>'id')::uuid,'call',a,0);RAISE EXCEPTION 'EXPECTED_VERSION_CONFLICT';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'VERSION_CONFLICT' THEN RAISE;END IF;END;UPDATE qms.users SET services=ARRAY['general'] WHERE id=a;BEGIN PERFORM qms.ticket_action((t->>'id')::uuid,'call',a,(t->>'version')::int);RAISE EXCEPTION 'EXPECTED_FORBIDDEN';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'FORBIDDEN' THEN RAISE;END IF;END;`,
    ));
  it('maintains a monotonic round-robin cursor inside a single transaction', () =>
    check(
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);PERFORM qms.assign_ticket((t->>'id')::uuid,a,'test');SELECT rotation INTO before_a FROM qms.users WHERE id=a;PERFORM qms.assign_ticket((t->>'id')::uuid,b,'test');SELECT rotation INTO before_b FROM qms.users WHERE id=b;IF before_a IS NULL OR before_b IS NULL OR before_b<=before_a THEN RAISE EXCEPTION 'Round robin cursor is not monotonic';END IF;IF qms.choose_available('crm-general') IS DISTINCT FROM a THEN RAISE EXCEPTION 'Round robin ordering failed';END IF;`,
    ));
  // Migration 017. Work at one counter must count at every other counter the
  // same person covers, or whoever helps in the most places is handed the most
  // customers.
  it('carries one rotation across every service a person covers', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    IF t->>'assigned_to' IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'Owner not selected';END IF;
    SELECT rotation INTO before_a FROM qms.users WHERE id=a;
    SELECT rotation INTO before_b FROM qms.users WHERE id=b;
    IF before_a<=before_b THEN RAISE EXCEPTION 'Assignment did not move the agent to the back of the rotation';END IF;
    UPDATE qms.tickets SET status='closed',closed_at=now() WHERE id=(t->>'id')::uuid;
    IF qms.choose_available('collection') IS DISTINCT FROM b THEN RAISE EXCEPTION 'A customer taken in one service did not count in another';END IF;
  `));
  // Migration 017. Ten waiting customers used to land on one agent's name
  // because only a called or serving ticket counted as busy.
  it('never offers a second customer to somebody already holding one', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    IF t->>'assigned_to' IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'Owner not selected';END IF;
    IF qms.choose_available('crm-general') IS DISTINCT FROM b THEN RAISE EXCEPTION 'An agent holding a waiting ticket was offered another';END IF;
    UPDATE qms.users SET online=false WHERE id=b;
    IF qms.choose_available('crm-general') IS NOT NULL THEN RAISE EXCEPTION 'A busy agent was offered a second customer';END IF;
  `));
  // Migration 017. Holding one customer at a time must not leave an agent idle
  // waiting for the next routing tick.
  it('offers the next waiting customer the moment a visit closes', () =>
    check(`
    -- Earlier runs leave waiting tickets in the shared test database and this
    -- assertion is about which customer a freed agent is offered, so the queue
    -- starts empty. The fixture transaction rolls all of it back.
    UPDATE qms.tickets SET status='closed',closed_at=now() WHERE status IN ('waiting','called','serving');
    UPDATE qms.users SET online=false WHERE id=b;
    INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer)
     VALUES(actor,'mobile','second-'||r,jsonb_set(snapshot,'{salesforceId}',to_jsonb('other-'||r))) RETURNING id INTO lookup2;
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    t2:=qms.issue_ticket(lookup2,'crm-general','unit-1',gen_random_uuid(),actor);
    IF t2->>'assigned_to' IS NOT NULL THEN RAISE EXCEPTION 'Second customer was given to a busy agent';END IF;
    SELECT version INTO v FROM qms.tickets WHERE id=(t->>'id')::uuid;
    PERFORM qms.ticket_action((t->>'id')::uuid,'call',a,v);
    SELECT version INTO v FROM qms.tickets WHERE id=(t->>'id')::uuid;
    PERFORM qms.ticket_action((t->>'id')::uuid,'start',a,v);
    SELECT version INTO v FROM qms.tickets WHERE id=(t->>'id')::uuid;
    PERFORM qms.ticket_action((t->>'id')::uuid,'close',a,v);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t2->>'id')::uuid;
    IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'A freed agent was not offered the waiting customer';END IF;
  `));
  // Migration 017. A refund can now be put ahead of a general enquiry.
  it('routes a higher-urgency service before an older ticket elsewhere', () =>
    check(`
    UPDATE qms.tickets SET status='closed',closed_at=now() WHERE status IN ('waiting','called','serving');
    UPDATE qms.users SET services=ARRAY['crm-general','crm-refund'],online=false WHERE id IN (a,b);
    UPDATE qms.services SET priority=9 WHERE id='crm-refund';
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    t2:=qms.issue_ticket(lookup,'crm-refund','unit-1',gen_random_uuid(),actor);
    IF t->>'assigned_to' IS NOT NULL OR t2->>'assigned_to' IS NOT NULL THEN RAISE EXCEPTION 'Tickets should be unassigned while nobody is online';END IF;
    UPDATE qms.users SET online=true,last_seen=now() WHERE id=a;
    PERFORM qms.route_waiting(25,0);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t2->>'id')::uuid;
    IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'The urgent service was not routed first';END IF;
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS NOT NULL THEN RAISE EXCEPTION 'The older lower-urgency ticket took the only agent';END IF;
  `));
  // Migration 017. The preferred owner still wins, but for one customer only.
  it('sends a second customer past a preferred owner who already holds one', () =>
    check(`
    INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer)
     VALUES(actor,'mobile','third-'||r,jsonb_set(snapshot,'{salesforceId}',to_jsonb('third-'||r))) RETURNING id INTO lookup2;
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    IF t->>'assigned_to' IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'Owner not selected for the first customer';END IF;
    t2:=qms.issue_ticket(lookup2,'crm-general','unit-1',gen_random_uuid(),actor);
    IF t2->>'assigned_to' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'A queue was allowed to build on the preferred owner';END IF;
  `));
  it('rejects a Collection call by a local manager after service access is removed', () =>
    check(`
    t:=qms.issue_ticket(lookup,'collection','unit-1',r,actor);
    UPDATE qms.users SET sf_id=NULL,online=true,last_seen=now(),services=ARRAY[]::text[] WHERE id=manager;
    PERFORM qms.assign_ticket((t->>'id')::uuid,manager,'test');
    SELECT version INTO v FROM qms.tickets WHERE id=(t->>'id')::uuid;
    BEGIN PERFORM qms.ticket_action((t->>'id')::uuid,'call',manager,v);RAISE EXCEPTION 'EXPECTED_FORBIDDEN';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'FORBIDDEN' THEN RAISE;END IF;END;
  `));
  it('continues automatic CRM rotation without bouncing immediately after reassignment', () =>
    check(`
    UPDATE qms.users SET online=false WHERE id=a;
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    IF t->>'assigned_to' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'Initial fallback missing';END IF;
    UPDATE qms.users SET online=true,last_seen=now() WHERE id=a;
    UPDATE qms.tickets SET assigned_at=now()-interval '5 minutes 0.001 seconds' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_ticket((t->>'id')::uuid);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'Escalated CRM ticket stopped rotating';END IF;
    PERFORM qms.route_ticket((t->>'id')::uuid);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'Fresh reassignment bounced';END IF;
  `));
  it('gives a manual CRM reassignment a fresh window then resumes routing', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    t:=qms.ticket_action((t->>'id')::uuid,'reassign',actor,(t->>'version')::int,NULL,b);
    UPDATE qms.tickets SET created_at=now()-interval '20 minutes' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_ticket((t->>'id')::uuid);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS DISTINCT FROM b THEN RAISE EXCEPTION 'Manual assignment was immediately reversed';END IF;
    UPDATE qms.tickets SET assigned_at=now()-interval '5 minutes 0.001 seconds' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_ticket((t->>'id')::uuid);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS DISTINCT FROM a THEN RAISE EXCEPTION 'Manual CRM assignment became permanently stuck';END IF;
  `));
  it('escalates Collection after the assigned owner waiting window expires', () =>
    check(`
    t:=qms.issue_ticket(lookup,'collection','unit-1',r,actor);
    UPDATE qms.tickets SET assigned_at=now()-interval '5 minutes 0.001 seconds' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_ticket((t->>'id')::uuid);
    SELECT assigned_to INTO chosen FROM qms.tickets WHERE id=(t->>'id')::uuid;
    IF chosen IS DISTINCT FROM manager THEN RAISE EXCEPTION 'Collection timeout escalation failed';END IF;
  `));
  it('prevents removing a queue member during an active call', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    t:=qms.ticket_action((t->>'id')::uuid,'call',a,(t->>'version')::int);
    BEGIN PERFORM qms.set_queue_member('crm-general',a,false,actor);RAISE EXCEPTION 'EXPECTED_AGENT_BUSY';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'AGENT_BUSY' THEN RAISE;END IF;END;
    IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=a AND 'crm-general'=ANY(services)) THEN RAISE EXCEPTION 'Membership partly removed';END IF;
    IF NOT ('crm-noc'=ANY(qms.set_queue_member('crm-noc',a,true,actor))) THEN RAISE EXCEPTION 'Adding a member failed';END IF;
    BEGIN PERFORM qms.set_queue_member('crm-noc',a,true,a);RAISE EXCEPTION 'EXPECTED_FORBIDDEN';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'FORBIDDEN' THEN RAISE;END IF;END;
  `));
  it('serves a registered customer with no units as General Query only', () =>
    check(`
    UPDATE qms.lookups SET customer=jsonb_set(customer,'{units}','[]'::jsonb) WHERE id=lookup;
    BEGIN PERFORM qms.issue_ticket(lookup,'crm-general',NULL,r,actor);RAISE EXCEPTION 'EXPECTED_INVALID_SERVICE';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'INVALID_SERVICE' THEN RAISE;END IF;END;
    t:=qms.issue_ticket(lookup,'general',NULL,r,actor);
    IF t->>'service_id' IS DISTINCT FROM 'general' OR t->>'customer_id' IS NULL OR t->>'unit_id' IS NOT NULL THEN RAISE EXCEPTION 'No-unit registered visit not recorded';END IF;
  `));
  it('still refuses General Query for a registered customer with units', () =>
    check(
      `BEGIN PERFORM qms.issue_ticket(lookup,'general',NULL,r,actor);RAISE EXCEPTION 'EXPECTED_INVALID_SERVICE';EXCEPTION WHEN OTHERS THEN IF SQLERRM IS DISTINCT FROM 'INVALID_SERVICE' THEN RAISE;END IF;END;`,
    ));
  it('audits presence changes but not repeated heartbeats', () =>
    check(`
    PERFORM qms.set_presence(a,true);PERFORM qms.set_presence(a,true);
    IF (SELECT count(*) FROM qms.events WHERE actor_id=a AND action='presence_online')<>0 THEN RAISE EXCEPTION 'Heartbeat audited as a change';END IF;
    PERFORM qms.set_presence(a,false);
    IF (SELECT count(*) FROM qms.events WHERE actor_id=a AND action='presence_offline')<>1 THEN RAISE EXCEPTION 'Going offline not audited';END IF;
    PERFORM qms.set_presence(a,true);
    IF (SELECT count(*) FROM qms.events WHERE actor_id=a AND action='presence_online')<>1 THEN RAISE EXCEPTION 'Going online not audited';END IF;
  `));
});
describe('Day rollover, number reuse and retention', () => {
  it('marks a ticket left waiting from a previous day as no-show once it is two hours old', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    UPDATE qms.tickets SET day=(now() AT TIME ZONE 'Asia/Dubai')::date-1,sequence=990000+(random()*9999)::int,created_at=now()-interval '1 hour' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_due();
    IF (SELECT status FROM qms.tickets WHERE id=(t->>'id')::uuid) IS DISTINCT FROM 'waiting' THEN RAISE EXCEPTION 'Recent ticket expired too early';END IF;
    UPDATE qms.tickets SET created_at=now()-interval '3 hours' WHERE id=(t->>'id')::uuid;
    PERFORM qms.route_due();
    IF (SELECT status FROM qms.tickets WHERE id=(t->>'id')::uuid) IS DISTINCT FROM 'no_show' THEN RAISE EXCEPTION 'Overnight ticket not expired';END IF;
    IF NOT EXISTS(SELECT 1 FROM qms.events WHERE ticket_id=(t->>'id')::uuid AND action='no_show' AND details->>'reason'='day_rollover') THEN RAISE EXCEPTION 'Rollover not audited';END IF;
  `));
  it('skips a number still shown by an active ticket from a previous day', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    UPDATE qms.tickets SET day=(now() AT TIME ZONE 'Asia/Dubai')::date-1,sequence=990000+(random()*9999)::int,status='serving',started_at=now() WHERE id=(t->>'id')::uuid;
    UPDATE qms.counters SET value=value-1 WHERE day=(now() AT TIME ZONE 'Asia/Dubai')::date AND service_id='crm-general';
    snapshot:=jsonb_set(snapshot,'{salesforceId}',to_jsonb('second-'||r));
    INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES(actor,'mobile','second-'||r,snapshot) RETURNING id INTO lookup2;
    t2:=qms.issue_ticket(lookup2,'crm-general','unit-1',gen_random_uuid(),actor);
    IF t2->>'number' IS NOT DISTINCT FROM t->>'number' THEN RAISE EXCEPTION 'Number reused while still active';END IF;
    IF (t2->>'sequence')::int<>(t->>'sequence')::int+1 THEN RAISE EXCEPTION 'Number not advanced by exactly one';END IF;
  `));
  it('anonymises identifiers on tickets closed beyond the period and redacts their lookup', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    UPDATE qms.tickets SET status='closed',closed_at=now()-interval '40 days' WHERE id=(t->>'id')::uuid;
    UPDATE qms.outbox SET status='sent' WHERE ticket_id=(t->>'id')::uuid;
    DELETE FROM qms.system_state WHERE key='retention';
    snapshot:=qms.apply_retention(30,NULL);
    IF (snapshot->>'anonymised')::int<1 THEN RAISE EXCEPTION 'Nothing anonymised';END IF;
    IF (SELECT mobile IS NOT NULL OR customer_name<>'Customer' FROM qms.tickets WHERE id=(t->>'id')::uuid) THEN RAISE EXCEPTION 'Identifiers kept';END IF;
    IF (SELECT customer ? 'mobile' OR customer ? 'name' OR identifier_value<>'' FROM qms.lookups WHERE id=lookup) THEN RAISE EXCEPTION 'Lookup not redacted';END IF;
    IF (SELECT unit_name FROM qms.tickets WHERE id=(t->>'id')::uuid) IS DISTINCT FROM '101' THEN RAISE EXCEPTION 'Business data lost';END IF;
    IF NOT EXISTS(SELECT 1 FROM qms.events WHERE action='retention') THEN RAISE EXCEPTION 'Retention not audited';END IF;
    snapshot:=qms.apply_retention(30,NULL);
    IF NOT (snapshot->>'skipped')::boolean THEN RAISE EXCEPTION 'Second run within the hour not throttled';END IF;
  `));
  it('keeps identifiers of tickets closed within the period and of open tickets', () =>
    check(`
    t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);
    UPDATE qms.tickets SET status='closed',closed_at=now()-interval '5 days' WHERE id=(t->>'id')::uuid;
    UPDATE qms.outbox SET status='sent' WHERE ticket_id=(t->>'id')::uuid;
    DELETE FROM qms.system_state WHERE key='retention';
    PERFORM qms.apply_retention(30,NULL);
    IF (SELECT mobile FROM qms.tickets WHERE id=(t->>'id')::uuid) IS NULL THEN RAISE EXCEPTION 'Recent ticket anonymised';END IF;
    IF (SELECT customer ? 'mobile' FROM qms.lookups WHERE id=lookup) IS NOT TRUE THEN RAISE EXCEPTION 'Recent lookup redacted';END IF;
  `));
  it('stops handing customers to an agent silent for more than 45 seconds', () =>
    check(`
    UPDATE qms.users SET online=false WHERE id=b;
    UPDATE qms.users SET last_seen=now()-interval '50 seconds' WHERE id=a;
    IF qms.choose_available('general') IS NOT NULL THEN RAISE EXCEPTION 'Silent agent still chosen';END IF;
    UPDATE qms.users SET last_seen=now()-interval '40 seconds' WHERE id=a;
    IF qms.choose_available('general') IS DISTINCT FROM a THEN RAISE EXCEPTION 'Recent heartbeat not accepted';END IF;
    UPDATE qms.users SET last_seen=now()-interval '50 seconds' WHERE id=a;
    PERFORM qms.route_due();
    IF (SELECT online FROM qms.users WHERE id=a) THEN RAISE EXCEPTION 'Silent agent not marked offline by the tick';END IF;
    IF NOT EXISTS(SELECT 1 FROM qms.events WHERE actor_id=a AND action='presence_offline' AND details->>'reason'='heartbeat_expired') THEN RAISE EXCEPTION 'Expiry not audited';END IF;
  `));
  it('deletes audit events older than the event period only', () =>
    check(`
    INSERT INTO qms.events(action,created_at) VALUES('fixture_old_'||r,now()-interval '400 days');
    INSERT INTO qms.events(action,created_at) VALUES('fixture_new_'||r,now()-interval '10 days');
    DELETE FROM qms.system_state WHERE key='retention';
    snapshot:=qms.apply_retention(NULL,365);
    IF EXISTS(SELECT 1 FROM qms.events WHERE action='fixture_old_'||r) THEN RAISE EXCEPTION 'Old event kept';END IF;
    IF NOT EXISTS(SELECT 1 FROM qms.events WHERE action='fixture_new_'||r) THEN RAISE EXCEPTION 'Recent event deleted';END IF;
    IF (snapshot->>'deletedEvents')::int<1 THEN RAISE EXCEPTION 'Deletion not counted';END IF;
  `));
});
