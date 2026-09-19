CREATE SCHEMA IF NOT EXISTS qms;
CREATE TABLE IF NOT EXISTS qms.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS qms.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE, name text NOT NULL,
 role text NOT NULL DEFAULT 'agent' CHECK(role IN ('admin','manager','agent','reception','kiosk','display')),
 password_hash text, sf_id text UNIQUE, manager_sf_id text, services text[] NOT NULL DEFAULT '{}',
 online boolean NOT NULL DEFAULT false, last_seen timestamptz, counter text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true, must_change_password boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS qms.sessions (token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES qms.users(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_expiry ON qms.sessions(expires_at);
CREATE TABLE IF NOT EXISTS qms.rate_limits (key text NOT NULL,window_start timestamptz NOT NULL,count integer NOT NULL,PRIMARY KEY(key,window_start));
CREATE TABLE IF NOT EXISTS qms.services (id text PRIMARY KEY,name text NOT NULL,department text NOT NULL,prefix text NOT NULL UNIQUE);
INSERT INTO qms.services(id,name,department,prefix) VALUES ('crm-general','General Query','CRM','C'),('crm-noc','NOC / Resale','CRM','N'),('crm-refund','Refund','CRM','R'),('crm-handover','Handover','CRM','H'),('collection','Collections','Collection','P'),('general','General Query','General Query','G') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS qms.lookups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES qms.users(id),identifier_type text NOT NULL,identifier_value text NOT NULL,customer jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes');
CREATE TABLE IF NOT EXISTS qms.counters (day date NOT NULL,service_id text NOT NULL REFERENCES qms.services(id),value integer NOT NULL,PRIMARY KEY(day,service_id));
CREATE TABLE IF NOT EXISTS qms.tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number text NOT NULL,day date NOT NULL,sequence integer NOT NULL,
 request_id uuid NOT NULL UNIQUE,lookup_id uuid NOT NULL REFERENCES qms.lookups(id),service_id text NOT NULL REFERENCES qms.services(id),
 status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','called','serving','closed','no_show')),
 customer_id text,customer_name text NOT NULL,mobile text,emirates_id text,passport_number text,identifier_type text NOT NULL,
 unit_id text,unit_name text,project_name text,booking_number text,owner_sf_id text,manager_sf_id text,
 assigned_to uuid REFERENCES qms.users(id),assigned_at timestamptz,routing_reason text NOT NULL DEFAULT 'awaiting_agent',escalated boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES qms.users(id),created_at timestamptz NOT NULL DEFAULT now(),called_at timestamptz,started_at timestamptz,closed_at timestamptz,comments text,version integer NOT NULL DEFAULT 1,
 UNIQUE(day,service_id,sequence)
);
CREATE INDEX IF NOT EXISTS tickets_queue ON qms.tickets(service_id,status,created_at);
CREATE INDEX IF NOT EXISTS tickets_assigned ON qms.tickets(assigned_to,status);
CREATE INDEX IF NOT EXISTS tickets_created ON qms.tickets(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_service_per_agent ON qms.tickets(assigned_to) WHERE status IN ('called','serving') AND assigned_to IS NOT NULL;
CREATE TABLE IF NOT EXISTS qms.round_robin (service_id text NOT NULL REFERENCES qms.services(id),user_id uuid NOT NULL REFERENCES qms.users(id),last_assigned timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(service_id,user_id));
CREATE TABLE IF NOT EXISTS qms.events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,ticket_id uuid REFERENCES qms.tickets(id),actor_id uuid REFERENCES qms.users(id),action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS events_ticket ON qms.events(ticket_id,created_at);
CREATE TABLE IF NOT EXISTS qms.notifications (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES qms.users(id),ticket_id uuid NOT NULL REFERENCES qms.tickets(id),created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz);
CREATE TABLE IF NOT EXISTS qms.outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES qms.tickets(id),kind text NOT NULL CHECK(kind IN ('sms','salesforce')),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','disabled')),attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,last_error text,provider_reference text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(ticket_id,kind));
CREATE TABLE IF NOT EXISTS qms.system_state (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE VIEW qms.ticket_view AS SELECT t.*,s.name service_name,s.department,u.name assigned_name,u.counter FROM qms.tickets t JOIN qms.services s ON s.id=t.service_id LEFT JOIN qms.users u ON u.id=t.assigned_to;

CREATE OR REPLACE FUNCTION qms.assign_ticket(p_ticket uuid,p_user uuid,p_reason text,p_actor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior uuid;
BEGIN
 SELECT assigned_to INTO prior FROM qms.tickets WHERE id=p_ticket;
 UPDATE qms.tickets SET assigned_to=p_user,assigned_at=CASE WHEN p_user IS NULL THEN NULL ELSE now() END,routing_reason=p_reason,version=version+1 WHERE id=p_ticket;
 IF p_user IS DISTINCT FROM prior THEN
  INSERT INTO qms.events(ticket_id,actor_id,action,details) VALUES(p_ticket,p_actor,'assigned',jsonb_build_object('from',prior,'to',p_user,'reason',p_reason));
  IF p_user IS NOT NULL THEN
   INSERT INTO qms.notifications(user_id,ticket_id) VALUES(p_user,p_ticket);
   INSERT INTO qms.round_robin(service_id,user_id,last_assigned) SELECT service_id,p_user,now() FROM qms.tickets WHERE id=p_ticket ON CONFLICT(service_id,user_id) DO UPDATE SET last_assigned=excluded.last_assigned;
  END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION qms.choose_available(p_service text,p_exclude uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
 SELECT u.id FROM qms.users u LEFT JOIN qms.round_robin rr ON rr.service_id=p_service AND rr.user_id=u.id
 WHERE u.enabled AND u.online AND u.last_seen>now()-interval '90 seconds' AND u.role IN ('agent','manager','admin') AND p_service=ANY(u.services) AND (p_exclude IS NULL OR u.id<>p_exclude)
 AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('called','serving'))
 ORDER BY rr.last_assigned ASC NULLS FIRST,u.created_at,u.id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION qms.route_ticket(p_ticket uuid,p_initial boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t qms.tickets; owner_user qms.users; assigned_user qms.users; candidate uuid; manager_user qms.users; owner_available boolean;
BEGIN
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;
 IF t.status<>'waiting' THEN RETURN; END IF;
 SELECT * INTO owner_user FROM qms.users WHERE sf_id=t.owner_sf_id AND enabled AND role IN ('agent','manager','admin');
 owner_available:=owner_user.id IS NOT NULL AND owner_user.online AND owner_user.last_seen>now()-interval '90 seconds' AND t.service_id=ANY(owner_user.services);
 IF p_initial AND owner_available THEN
  PERFORM qms.assign_ticket(t.id,owner_user.id,CASE WHEN EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=owner_user.id AND status IN ('called','serving')) THEN 'owner_busy_five_minute_hold' ELSE 'preferred_owner' END);
  RETURN;
 END IF;
 IF NOT p_initial AND t.assigned_to IS NOT NULL THEN
  SELECT * INTO assigned_user FROM qms.users WHERE id=t.assigned_to;
  IF t.escalated AND t.service_id='collection' THEN RETURN; END IF;
  IF assigned_user.enabled AND assigned_user.online AND assigned_user.last_seen>now()-interval '90 seconds' AND (t.escalated OR now()<=t.created_at+interval '5 minutes') THEN RETURN; END IF;
 END IF;
 IF t.service_id='collection' THEN
  SELECT * INTO manager_user FROM qms.users WHERE sf_id=t.manager_sf_id AND enabled AND role IN ('manager','admin');
  IF manager_user.id IS NOT NULL THEN
   PERFORM qms.assign_ticket(t.id,manager_user.id,CASE WHEN manager_user.online AND manager_user.last_seen>now()-interval '90 seconds' THEN 'escalated_to_manager' ELSE 'manager_offline_attention_required' END);
   UPDATE qms.tickets SET escalated=true WHERE id=t.id;
  ELSE
   IF t.assigned_to IS NOT NULL OR t.routing_reason<>'manager_mapping_missing' THEN PERFORM qms.assign_ticket(t.id,NULL,'manager_mapping_missing'); END IF;
  END IF;
 ELSE
  candidate:=qms.choose_available(t.service_id,t.assigned_to);
  IF candidate IS NOT NULL THEN
   PERFORM qms.assign_ticket(t.id,candidate,CASE WHEN p_initial THEN 'round_robin' ELSE 'reassigned_round_robin' END);
   UPDATE qms.tickets SET escalated=true WHERE id=t.id;
  ELSE
   IF t.assigned_to IS NOT NULL AND (NOT assigned_user.enabled OR NOT assigned_user.online OR assigned_user.last_seen<=now()-interval '90 seconds') THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent');
   ELSIF t.assigned_to IS NULL AND t.routing_reason<>'no_available_agent' THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent'); END IF;
  END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION qms.issue_ticket(p_lookup uuid,p_service text,p_unit text,p_request uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l qms.lookups; c jsonb; unit jsonb; s qms.services; tid uuid; seq integer; visit_day date; ticket_number text; existing qms.tickets;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO existing FROM qms.tickets WHERE request_id=p_request;
 IF FOUND THEN IF existing.created_by<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=existing.id);END IF;
 SELECT * INTO l FROM qms.lookups WHERE id=p_lookup AND actor_id=p_actor AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'LOOKUP_EXPIRED';END IF;
 c:=l.customer;
 SELECT * INTO s FROM qms.services WHERE id=p_service;
 IF NOT FOUND OR ((c->>'registered')::boolean=false AND p_service<>'general') OR ((c->>'registered')::boolean AND p_service='general') THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF (c->>'registered')::boolean THEN
  SELECT value INTO unit FROM jsonb_array_elements(c->'units') WHERE value->>'id'=p_unit;
  IF unit IS NULL THEN RAISE EXCEPTION 'UNIT_REQUIRED';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM qms.tickets t JOIN qms.lookups old ON old.id=t.lookup_id WHERE t.status IN ('waiting','called','serving') AND t.service_id=p_service AND coalesce(t.unit_id,'')=coalesce(p_unit,'') AND ((t.customer_id IS NOT NULL AND t.customer_id=c->>'salesforceId') OR (old.identifier_type=l.identifier_type AND old.identifier_value=l.identifier_value))) THEN RAISE EXCEPTION 'DUPLICATE_VISIT';END IF;
 visit_day:=(now() AT TIME ZONE 'Asia/Dubai')::date;
 INSERT INTO qms.counters(day,service_id,value) VALUES(visit_day,p_service,1) ON CONFLICT(day,service_id) DO UPDATE SET value=qms.counters.value+1 RETURNING value INTO seq;
 ticket_number:=s.prefix||'-'||lpad(seq::text,3,'0');
 INSERT INTO qms.tickets(number,day,sequence,request_id,lookup_id,service_id,customer_id,customer_name,mobile,emirates_id,passport_number,identifier_type,unit_id,unit_name,project_name,booking_number,owner_sf_id,manager_sf_id,created_by)
 VALUES(ticket_number,visit_day,seq,p_request,p_lookup,p_service,c->>'salesforceId',coalesce(nullif(c->>'name',''),'Walk-in customer'),c->>'mobile',c->>'emiratesId',c->>'passportNumber',l.identifier_type,unit->>'id',unit->>'name',unit->>'project',unit->>'bookingNumber',unit->>'ownerId',unit->>'managerId',p_actor) RETURNING id INTO tid;
 INSERT INTO qms.events(ticket_id,actor_id,action) VALUES(tid,p_actor,'issued');
 PERFORM qms.route_ticket(tid,true);
 IF l.identifier_type='mobile' AND (c->>'registered')::boolean AND nullif(c->>'mobile','') IS NOT NULL THEN INSERT INTO qms.outbox(ticket_id,kind) VALUES(tid,'sms');END IF;
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=tid);
END $$;

CREATE OR REPLACE FUNCTION qms.ticket_action(p_ticket uuid,p_action text,p_actor uuid,p_version integer,p_comment text DEFAULT NULL,p_target uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t qms.tickets; u qms.users; target qms.users; privileged boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'TICKET_NOT_FOUND';END IF;
 SELECT * INTO u FROM qms.users WHERE id=p_actor AND enabled;privileged:=u.role IN ('manager','admin');
 IF u.id IS NULL OR u.role NOT IN ('agent','manager','admin') OR (NOT privileged AND t.assigned_to IS DISTINCT FROM u.id) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF t.version<>p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF p_action='reassign' THEN
  IF NOT privileged THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF t.status NOT IN ('waiting','called') THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  SELECT * INTO target FROM qms.users WHERE id=p_target AND enabled AND online AND last_seen>now()-interval '90 seconds' AND t.service_id=ANY(services) AND role IN ('agent','manager','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ASSIGNEE';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=target.id AND status IN ('called','serving') AND id<>t.id) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.tickets SET status='waiting',called_at=NULL,escalated=true WHERE id=t.id;
  PERFORM qms.assign_ticket(t.id,target.id,'manager_reassignment',p_actor);
 ELSIF p_action='call' THEN
  IF t.status<>'waiting' THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  IF NOT u.online OR u.last_seen<=now()-interval '90 seconds' THEN RAISE EXCEPTION 'AGENT_UNAVAILABLE';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=u.id AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  IF t.assigned_to IS DISTINCT FROM u.id THEN
   IF NOT privileged OR NOT(t.service_id=ANY(u.services)) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
   PERFORM qms.assign_ticket(t.id,u.id,'manager_call',p_actor);
  END IF;
  UPDATE qms.tickets SET status='called',called_at=now(),version=version+1 WHERE id=t.id;
 ELSIF p_action='start' THEN
  IF t.status<>'called' OR t.assigned_to IS DISTINCT FROM u.id THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  UPDATE qms.tickets SET status='serving',started_at=now(),version=version+1 WHERE id=t.id;
 ELSIF p_action='close' THEN
  IF t.status IN ('closed','no_show') OR (NOT privileged AND t.status<>'serving') THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  UPDATE qms.tickets SET status='closed',closed_at=now(),comments=p_comment,version=version+1 WHERE id=t.id;
 ELSIF p_action='no_show' THEN
  IF t.status<>'called' THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  UPDATE qms.tickets SET status='no_show',closed_at=now(),comments=p_comment,version=version+1 WHERE id=t.id;
 ELSE RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
 INSERT INTO qms.events(ticket_id,actor_id,action,details) VALUES(t.id,p_actor,p_action,jsonb_build_object('comment',p_comment));
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=t.id);
END $$;

CREATE OR REPLACE FUNCTION qms.route_due() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; total integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 FOR item IN SELECT id FROM qms.tickets WHERE status='waiting' ORDER BY created_at LOOP
  PERFORM qms.route_ticket(item.id,false);total:=total+1;
 END LOOP;
 UPDATE qms.users SET online=false WHERE online AND last_seen<now()-interval '90 seconds';
 DELETE FROM qms.sessions WHERE expires_at<now();
 DELETE FROM qms.rate_limits WHERE window_start<now()-interval '1 day';
 INSERT INTO qms.system_state(key,value) VALUES('worker',jsonb_build_object('lastRun',now(),'checked',total)) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now();
 RETURN total;
END $$;
