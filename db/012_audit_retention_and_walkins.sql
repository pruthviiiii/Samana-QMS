-- Audit presence changes, purge stale guest data on every routing tick, and let a
-- registered customer with no linked units be served as a General Query visit.

-- Presence: record every change of availability, whether asserted by the agent
-- or expired by the scheduler, so "who was available at 11:00" can be answered.
CREATE OR REPLACE FUNCTION qms.set_presence(p_user uuid,p_online boolean,p_counter text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE was boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT p_online AND EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 SELECT online INTO was FROM qms.users WHERE id=p_user AND enabled;
 UPDATE qms.users SET online=p_online,last_seen=now(),counter=coalesce(p_counter,counter) WHERE id=p_user AND enabled;
 IF FOUND AND was IS DISTINCT FROM p_online THEN
  INSERT INTO qms.events(actor_id,action) VALUES(p_user,CASE WHEN p_online THEN 'presence_online' ELSE 'presence_offline' END);
 END IF;
END $$;

-- Scheduler tick: routing sweep, presence expiry (audited), session and
-- rate-window cleanup, and retention: lookup snapshots that expired more than a
-- day ago and are not attached to a ticket are removed; QR guest accounts older
-- than a day that never issued a ticket are removed (their lookup events keep
-- the row but lose the actor link).
CREATE OR REPLACE FUNCTION qms.route_due() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; total integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 FOR item IN SELECT id FROM qms.tickets WHERE status='waiting' ORDER BY created_at LOOP
  PERFORM qms.route_ticket(item.id,false);total:=total+1;
 END LOOP;
 WITH expired AS (UPDATE qms.users SET online=false WHERE online AND last_seen<now()-interval '90 seconds' RETURNING id)
 INSERT INTO qms.events(actor_id,action,details) SELECT id,'presence_offline','{"reason":"heartbeat_expired"}'::jsonb FROM expired;
 DELETE FROM qms.sessions WHERE expires_at<now();
 DELETE FROM qms.rate_limits WHERE window_start<now()-interval '1 day';
 DELETE FROM qms.lookups l WHERE l.expires_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.lookup_id=l.id);
 UPDATE qms.events e SET actor_id=NULL FROM qms.users u
  WHERE e.actor_id=u.id AND u.role='customer' AND u.created_at<now()-interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM qms.sessions s WHERE s.user_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.created_by=u.id OR t.assigned_to=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.lookups l WHERE l.actor_id=u.id);
 DELETE FROM qms.users u
  WHERE u.role='customer' AND u.created_at<now()-interval '1 day'
   AND NOT EXISTS(SELECT 1 FROM qms.sessions s WHERE s.user_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.created_by=u.id OR t.assigned_to=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.lookups l WHERE l.actor_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.events e WHERE e.actor_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.notifications n WHERE n.user_id=u.id)
   AND NOT EXISTS(SELECT 1 FROM qms.round_robin r WHERE r.user_id=u.id);
 INSERT INTO qms.system_state(key,value) VALUES('worker',jsonb_build_object('lastRun',now(),'checked',total)) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now();
 RETURN total;
END $$;

-- Issue: a registered customer whose account has no active units may be served
-- as a General Query visit (no unit attached). Registered customers with units
-- still choose a unit and a CRM or Collection service; guests still get General
-- Query only. Everything else is unchanged from migration 004.
CREATE OR REPLACE FUNCTION qms.issue_ticket(p_lookup uuid,p_service text,p_unit text,p_request uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l qms.lookups; c jsonb; unit jsonb; s qms.services; tid uuid; seq integer; visit_day date; ticket_number text; existing qms.tickets; registered boolean; has_units boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO existing FROM qms.tickets WHERE request_id=p_request;
 IF FOUND THEN IF existing.created_by<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; IF existing.lookup_id<>p_lookup OR existing.service_id<>p_service OR existing.unit_id IS DISTINCT FROM p_unit THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=existing.id);END IF;
 SELECT * INTO l FROM qms.lookups WHERE id=p_lookup AND actor_id=p_actor AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'LOOKUP_EXPIRED';END IF;
 c:=l.customer;
 registered:=coalesce((c->>'registered')::boolean,false);
 has_units:=jsonb_typeof(c->'units')='array' AND jsonb_array_length(c->'units')>0;
 SELECT * INTO s FROM qms.services WHERE id=p_service;
 IF NOT FOUND OR (NOT registered AND p_service<>'general') OR (registered AND has_units AND p_service='general') OR (registered AND NOT has_units AND p_service<>'general') THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF p_service='general' AND p_unit IS NOT NULL THEN RAISE EXCEPTION 'UNIT_NOT_ALLOWED';END IF;
 IF p_service<>'general' THEN
  SELECT value INTO unit FROM jsonb_array_elements(c->'units') WHERE value->>'id'=p_unit;
  IF unit IS NULL THEN RAISE EXCEPTION 'UNIT_REQUIRED';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM qms.tickets t JOIN qms.lookups old ON old.id=t.lookup_id WHERE t.status IN ('waiting','called','serving') AND t.service_id=p_service AND coalesce(t.unit_id,'')=coalesce(p_unit,'') AND ((t.customer_id IS NOT NULL AND t.customer_id=c->>'salesforceId') OR (old.identifier_type=l.identifier_type AND old.identifier_value=l.identifier_value))) THEN RAISE EXCEPTION 'DUPLICATE_VISIT';END IF;
 visit_day:=(now() AT TIME ZONE 'Asia/Dubai')::date;
 INSERT INTO qms.counters(day,service_id,value) VALUES(visit_day,p_service,1) ON CONFLICT(day,service_id) DO UPDATE SET value=qms.counters.value+1 RETURNING value INTO seq;
 ticket_number:=s.prefix||'-'||lpad(seq::text,greatest(3,length(seq::text)),'0');
 INSERT INTO qms.tickets(number,day,sequence,request_id,lookup_id,service_id,customer_id,customer_name,mobile,emirates_id,passport_number,identifier_type,unit_id,unit_name,project_name,booking_number,owner_sf_id,manager_sf_id,created_by)
 VALUES(ticket_number,visit_day,seq,p_request,p_lookup,p_service,c->>'salesforceId',coalesce(nullif(c->>'name',''),'Walk-in customer'),c->>'mobile',c->>'emiratesId',c->>'passportNumber',l.identifier_type,unit->>'id',unit->>'name',unit->>'project',unit->>'bookingNumber',CASE WHEN p_service LIKE 'crm-%' AND unit ? 'owners' THEN unit->'owners'->p_service->>'ownerId' ELSE unit->>'ownerId' END,CASE WHEN p_service LIKE 'crm-%' AND unit ? 'owners' THEN unit->'owners'->p_service->>'managerId' ELSE unit->>'managerId' END,p_actor) RETURNING id INTO tid;
 INSERT INTO qms.events(ticket_id,actor_id,action) VALUES(tid,p_actor,'issued');
 PERFORM qms.route_ticket(tid,true);
 IF l.identifier_type='mobile' AND registered AND nullif(c->>'mobile','') IS NOT NULL THEN INSERT INTO qms.outbox(ticket_id,kind) VALUES(tid,'sms');END IF;
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=tid);
END $$;
