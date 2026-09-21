-- 014: day rollover, ticket-number reuse guard and configurable retention.
-- 1. A ticket still waiting or called from a previous Dubai day is marked
--    no-show by the routing tick once it is more than two hours old, so
--    yesterday's tickets leave the queue and the TV instead of lingering.
-- 2. Today's numbering skips a number that an active ticket from an earlier
--    day still shows, so two tickets on the floor never share a number.
-- 3. qms.apply_retention(identifier_days, event_days) anonymises identifiers
--    on closed tickets and deletes old audit events. The scheduler tick calls
--    it with RETENTION_IDENTIFIER_DAYS and RETENTION_EVENT_DAYS at most once an
--    hour; unset means keep everything, which stays the case until a policy is agreed.
CREATE INDEX IF NOT EXISTS tickets_closed_at ON qms.tickets(closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_created ON qms.events(created_at);
CREATE OR REPLACE FUNCTION qms.issue_ticket(p_lookup uuid, p_service text, p_unit text, p_request uuid, p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
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
 -- Numbering restarts every day; a number an earlier day's ticket still shows on the floor is skipped.
 WHILE EXISTS(SELECT 1 FROM qms.tickets t WHERE t.number=ticket_number AND t.day<>visit_day AND t.status IN ('waiting','called','serving')) LOOP
  UPDATE qms.counters SET value=value+1 WHERE day=visit_day AND service_id=p_service RETURNING value INTO seq;
  ticket_number:=s.prefix||'-'||lpad(seq::text,greatest(3,length(seq::text)),'0');
 END LOOP;
 INSERT INTO qms.tickets(number,day,sequence,request_id,lookup_id,service_id,customer_id,customer_name,mobile,emirates_id,passport_number,identifier_type,unit_id,unit_name,project_name,booking_number,owner_sf_id,manager_sf_id,created_by)
 VALUES(ticket_number,visit_day,seq,p_request,p_lookup,p_service,c->>'salesforceId',coalesce(nullif(c->>'name',''),'Walk-in customer'),c->>'mobile',c->>'emiratesId',c->>'passportNumber',l.identifier_type,unit->>'id',unit->>'name',unit->>'project',unit->>'bookingNumber',CASE WHEN p_service LIKE 'crm-%' AND unit ? 'owners' THEN unit->'owners'->p_service->>'ownerId' ELSE unit->>'ownerId' END,CASE WHEN p_service LIKE 'crm-%' AND unit ? 'owners' THEN unit->'owners'->p_service->>'managerId' ELSE unit->>'managerId' END,p_actor) RETURNING id INTO tid;
 INSERT INTO qms.events(ticket_id,actor_id,action) VALUES(tid,p_actor,'issued');
 PERFORM qms.route_ticket(tid,true);
 IF l.identifier_type='mobile' AND registered AND nullif(c->>'mobile','') IS NOT NULL THEN INSERT INTO qms.outbox(ticket_id,kind) VALUES(tid,'sms');END IF;
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=tid);
END $$;
CREATE OR REPLACE FUNCTION qms.route_due() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; total integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 -- Day rollover: a ticket left waiting or called from a previous Dubai day is
 -- a no-show once it is more than two hours old. Serving tickets are left to
 -- the agent to complete.
 WITH stale AS (UPDATE qms.tickets SET status='no_show',closed_at=now(),version=version+1 WHERE status IN ('waiting','called') AND day<(now() AT TIME ZONE 'Asia/Dubai')::date AND created_at<now()-interval '2 hours' RETURNING id)
 INSERT INTO qms.events(ticket_id,action,details) SELECT id,'no_show','{"reason":"day_rollover"}'::jsonb FROM stale;
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
CREATE OR REPLACE FUNCTION qms.apply_retention(p_identifier_days integer, p_event_days integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE anonymised integer:=0; deleted integer:=0; last_run timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(1947302);
 SELECT updated_at INTO last_run FROM qms.system_state WHERE key='retention';
 IF last_run IS NOT NULL AND last_run>now()-interval '1 hour' THEN RETURN jsonb_build_object('skipped',true,'lastRun',last_run);END IF;
 IF coalesce(p_identifier_days,0)>0 THEN
  -- Closed tickets older than the period lose the customer's name and
  -- identifiers; the lookup snapshot behind them is redacted once no newer
  -- ticket still refers to it. Unit, project and Salesforce ids stay for reporting.
  WITH done AS (
   UPDATE qms.tickets t SET customer_name='Customer',mobile=NULL,emirates_id=NULL,passport_number=NULL
   WHERE t.closed_at IS NOT NULL AND t.closed_at<now()-make_interval(days=>p_identifier_days)
    AND (t.mobile IS NOT NULL OR t.emirates_id IS NOT NULL OR t.passport_number IS NOT NULL OR t.customer_name<>'Customer')
    AND NOT EXISTS(SELECT 1 FROM qms.outbox o WHERE o.ticket_id=t.id AND o.status IN ('pending','processing'))
   RETURNING t.lookup_id),
  redacted AS (
   UPDATE qms.lookups l SET identifier_value='',customer=(l.customer - 'name' - 'firstName' - 'middleName' - 'lastName' - 'mobile' - 'emiratesId' - 'passportNumber' - 'email')||'{"redacted":true}'::jsonb
   WHERE l.id IN (SELECT lookup_id FROM done) AND NOT (l.customer ? 'redacted')
    AND NOT EXISTS(SELECT 1 FROM qms.tickets t2 WHERE t2.lookup_id=l.id AND (t2.closed_at IS NULL OR t2.closed_at>=now()-make_interval(days=>p_identifier_days)))
   RETURNING l.id)
  SELECT count(*) INTO anonymised FROM done;
 END IF;
 IF coalesce(p_event_days,0)>0 THEN
  DELETE FROM qms.events WHERE created_at<now()-make_interval(days=>p_event_days);
  GET DIAGNOSTICS deleted=ROW_COUNT;
 END IF;
 INSERT INTO qms.system_state(key,value) VALUES('retention',jsonb_build_object('identifierDays',p_identifier_days,'eventDays',p_event_days,'anonymised',anonymised,'deletedEvents',deleted)) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now();
 IF anonymised>0 OR deleted>0 THEN INSERT INTO qms.events(action,details) VALUES('retention',jsonb_build_object('anonymised',anonymised,'deletedEvents',deleted,'identifierDays',p_identifier_days,'eventDays',p_event_days));END IF;
 RETURN jsonb_build_object('anonymised',anonymised,'deletedEvents',deleted);
END $$;
