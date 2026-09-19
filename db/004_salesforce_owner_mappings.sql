CREATE OR REPLACE FUNCTION qms.issue_ticket(p_lookup uuid,p_service text,p_unit text,p_request uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l qms.lookups; c jsonb; unit jsonb; s qms.services; tid uuid; seq integer; visit_day date; ticket_number text; existing qms.tickets;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO existing FROM qms.tickets WHERE request_id=p_request;
 IF FOUND THEN IF existing.created_by<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; IF existing.lookup_id<>p_lookup OR existing.service_id<>p_service OR existing.unit_id IS DISTINCT FROM p_unit THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=existing.id);END IF;
 SELECT * INTO l FROM qms.lookups WHERE id=p_lookup AND actor_id=p_actor AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'LOOKUP_EXPIRED';END IF;
 c:=l.customer;
 SELECT * INTO s FROM qms.services WHERE id=p_service;
 IF NOT FOUND OR ((c->>'registered')::boolean=false AND p_service<>'general') OR ((c->>'registered')::boolean AND p_service='general') THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF NOT (c->>'registered')::boolean AND p_unit IS NOT NULL THEN RAISE EXCEPTION 'UNIT_NOT_ALLOWED';END IF;
 IF (c->>'registered')::boolean THEN
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
 IF l.identifier_type='mobile' AND (c->>'registered')::boolean AND nullif(c->>'mobile','') IS NOT NULL THEN INSERT INTO qms.outbox(ticket_id,kind) VALUES(tid,'sms');END IF;
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=tid);
END $$;

