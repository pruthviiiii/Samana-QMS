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
      `t:=qms.issue_ticket(lookup,'crm-general','unit-1',r,actor);PERFORM qms.assign_ticket((t->>'id')::uuid,a,'test');SELECT position INTO before_a FROM qms.round_robin WHERE service_id='crm-general' AND user_id=a;PERFORM qms.assign_ticket((t->>'id')::uuid,b,'test');SELECT position INTO before_b FROM qms.round_robin WHERE service_id='crm-general' AND user_id=b;IF before_a IS NULL OR before_b IS NULL OR before_b<=before_a THEN RAISE EXCEPTION 'Round robin cursor is not monotonic';END IF;IF qms.choose_available('crm-general') IS DISTINCT FROM a THEN RAISE EXCEPTION 'Round robin ordering failed';END IF;`,
    ));
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
