-- Recheck service permissions with NULL-safe predicates; each CRM assignment gets a fresh five-minute window.
CREATE OR REPLACE FUNCTION qms.assign_ticket(p_ticket uuid,p_user uuid,p_reason text,p_actor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior uuid;
BEGIN
 SELECT assigned_to INTO prior FROM qms.tickets WHERE id=p_ticket;
 UPDATE qms.tickets SET assigned_to=p_user,assigned_at=CASE WHEN p_user IS NULL THEN NULL ELSE now() END,routing_reason=p_reason,version=version+1 WHERE id=p_ticket;
 IF p_user IS DISTINCT FROM prior THEN
  UPDATE qms.notifications SET read_at=now() WHERE ticket_id=p_ticket AND user_id IS DISTINCT FROM p_user AND read_at IS NULL;
  INSERT INTO qms.events(ticket_id,actor_id,action,details) VALUES(p_ticket,p_actor,'assigned',jsonb_build_object('from',prior,'to',p_user,'reason',p_reason));
  IF p_user IS NOT NULL THEN
   INSERT INTO qms.notifications(user_id,ticket_id) VALUES(p_user,p_ticket);
   INSERT INTO qms.round_robin(service_id,user_id,last_assigned,position) SELECT service_id,p_user,clock_timestamp(),nextval('qms.round_robin_position') FROM qms.tickets WHERE id=p_ticket ON CONFLICT(service_id,user_id) DO UPDATE SET last_assigned=excluded.last_assigned,position=excluded.position;
  END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION qms.route_ticket(p_ticket uuid,p_initial boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t qms.tickets; owner_user qms.users; assigned_user qms.users; candidate uuid; manager_user qms.users; owner_available boolean;
BEGIN
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;
 IF t.status<>'waiting' THEN RETURN; END IF;
 SELECT * INTO owner_user FROM qms.users WHERE sf_id=t.owner_sf_id AND enabled AND role IN ('agent','manager','hod','admin');
 owner_available:=owner_user.id IS NOT NULL AND owner_user.online AND owner_user.last_seen>now()-interval '90 seconds' AND t.service_id=ANY(owner_user.services);
 IF (p_initial OR (t.assigned_to IS NULL AND NOT t.escalated)) AND owner_available THEN
  PERFORM qms.assign_ticket(t.id,owner_user.id,CASE WHEN EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=owner_user.id AND status IN ('called','serving')) THEN 'owner_busy_five_minute_hold' ELSE 'preferred_owner' END);
  RETURN;
 END IF;
 IF NOT p_initial AND t.assigned_to IS NOT NULL THEN
  SELECT * INTO assigned_user FROM qms.users WHERE id=t.assigned_to;
  IF t.escalated AND t.service_id='collection' AND assigned_user.enabled AND assigned_user.role IN ('manager','hod','admin') AND assigned_user.sf_id=t.manager_sf_id THEN RETURN; END IF;
  IF assigned_user.enabled AND t.service_id=ANY(assigned_user.services) AND assigned_user.online AND assigned_user.last_seen>now()-interval '90 seconds' AND now()<=coalesce(t.assigned_at,t.created_at)+interval '5 minutes' THEN RETURN; END IF;
 END IF;
 IF t.service_id='collection' THEN
  SELECT * INTO manager_user FROM qms.users WHERE sf_id=t.manager_sf_id AND enabled AND role IN ('manager','hod','admin');
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
   IF t.assigned_to IS NOT NULL AND (NOT assigned_user.enabled OR NOT(t.service_id=ANY(assigned_user.services)) OR NOT assigned_user.online OR assigned_user.last_seen<=now()-interval '90 seconds') THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent');
   ELSIF t.assigned_to IS NULL AND t.routing_reason<>'no_available_agent' THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent'); END IF;
  END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION qms.ticket_action(p_ticket uuid,p_action text,p_actor uuid,p_version integer,p_comment text DEFAULT NULL,p_target uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t qms.tickets; u qms.users; target qms.users; privileged boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'TICKET_NOT_FOUND';END IF;
 SELECT * INTO u FROM qms.users WHERE id=p_actor AND enabled;privileged:=u.role IN ('manager','hod','admin');
 IF u.id IS NULL OR u.role NOT IN ('agent','manager','hod','admin') OR (NOT privileged AND t.assigned_to IS DISTINCT FROM u.id) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF t.version<>p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF p_action='reassign' THEN
  IF NOT privileged THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF t.status NOT IN ('waiting','called') THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  SELECT * INTO target FROM qms.users WHERE id=p_target AND enabled AND online AND last_seen>now()-interval '90 seconds' AND t.service_id=ANY(services) AND role IN ('agent','manager','hod','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ASSIGNEE';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=target.id AND status IN ('called','serving') AND id<>t.id) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.tickets SET status='waiting',called_at=NULL,escalated=true WHERE id=t.id;
  PERFORM qms.assign_ticket(t.id,target.id,'manager_reassignment',p_actor);
 ELSIF p_action='call' THEN
  IF t.status<>'waiting' THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  IF NOT(t.service_id=ANY(u.services)) AND NOT coalesce(privileged AND u.sf_id=t.manager_sf_id AND t.service_id='collection',false) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
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

UPDATE qms.notifications n SET read_at=now() FROM qms.tickets t WHERE t.id=n.ticket_id AND n.read_at IS NULL AND (t.assigned_to IS DISTINCT FROM n.user_id OR t.status IN ('closed','no_show'));
