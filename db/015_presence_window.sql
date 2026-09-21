-- 015: presence window 90 s -> 45 s.
-- The browser heartbeat now runs every 15 seconds (components/qms/app.tsx),
-- so an agent whose screen died stops receiving new customers 45 seconds
-- after the last heartbeat, and the routing tick moves their waiting
-- customers on within 15 seconds after that. A short Wi-Fi drop that
-- outlasts 45 seconds marks the agent offline; the next heartbeat brings them
-- back online automatically and both changes are audited.
-- Restated from db/schema.sql with the interval changed; nothing else differs.
CREATE OR REPLACE FUNCTION qms.choose_available(p_service text, p_exclude uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE sql
AS $function$
 SELECT u.id FROM qms.users u LEFT JOIN qms.round_robin rr ON rr.service_id=p_service AND rr.user_id=u.id
 WHERE u.enabled AND u.online AND u.last_seen>now()-interval '45 seconds' AND u.role IN ('agent','manager','hod','admin') AND p_service=ANY(u.services) AND (p_exclude IS NULL OR u.id<>p_exclude)
 AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('called','serving'))
 ORDER BY rr.position ASC NULLS FIRST,u.created_at,u.id LIMIT 1
$function$;
CREATE OR REPLACE FUNCTION qms.route_ticket(p_ticket uuid, p_initial boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE t qms.tickets; owner_user qms.users; assigned_user qms.users; candidate uuid; manager_user qms.users; owner_available boolean;
BEGIN
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;
 IF t.status<>'waiting' THEN RETURN; END IF;
 SELECT * INTO owner_user FROM qms.users WHERE sf_id=t.owner_sf_id AND enabled AND role IN ('agent','manager','hod','admin');
 owner_available:=owner_user.id IS NOT NULL AND owner_user.online AND owner_user.last_seen>now()-interval '45 seconds' AND t.service_id=ANY(owner_user.services);
 IF (p_initial OR (t.assigned_to IS NULL AND NOT t.escalated)) AND owner_available THEN
  PERFORM qms.assign_ticket(t.id,owner_user.id,CASE WHEN EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=owner_user.id AND status IN ('called','serving')) THEN 'owner_busy_five_minute_hold' ELSE 'preferred_owner' END);
  RETURN;
 END IF;
 IF NOT p_initial AND t.assigned_to IS NOT NULL THEN
  SELECT * INTO assigned_user FROM qms.users WHERE id=t.assigned_to;
  IF t.escalated AND t.service_id='collection' AND assigned_user.enabled AND assigned_user.role IN ('manager','hod','admin') AND assigned_user.sf_id=t.manager_sf_id THEN RETURN; END IF;
  IF assigned_user.enabled AND t.service_id=ANY(assigned_user.services) AND assigned_user.online AND assigned_user.last_seen>now()-interval '45 seconds' AND now()<=coalesce(t.assigned_at,t.created_at)+interval '5 minutes' THEN RETURN; END IF;
 END IF;
 IF t.service_id='collection' THEN
  SELECT * INTO manager_user FROM qms.users WHERE sf_id=t.manager_sf_id AND enabled AND role IN ('manager','hod','admin');
  IF manager_user.id IS NOT NULL THEN
   PERFORM qms.assign_ticket(t.id,manager_user.id,CASE WHEN manager_user.online AND manager_user.last_seen>now()-interval '45 seconds' THEN 'escalated_to_manager' ELSE 'manager_offline_attention_required' END);
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
   IF t.assigned_to IS NOT NULL AND (NOT assigned_user.enabled OR NOT(t.service_id=ANY(assigned_user.services)) OR NOT assigned_user.online OR assigned_user.last_seen<=now()-interval '45 seconds') THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent');
   ELSIF t.assigned_to IS NULL AND t.routing_reason<>'no_available_agent' THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent'); END IF;
  END IF;
 END IF;
END $function$;
CREATE OR REPLACE FUNCTION qms.route_due()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
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
 WITH expired AS (UPDATE qms.users SET online=false WHERE online AND last_seen<now()-interval '45 seconds' RETURNING id)
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
END $function$;
CREATE OR REPLACE FUNCTION qms.ticket_action(p_ticket uuid, p_action text, p_actor uuid, p_version integer, p_comment text DEFAULT NULL::text, p_target uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
  SELECT * INTO target FROM qms.users WHERE id=p_target AND enabled AND online AND last_seen>now()-interval '45 seconds' AND t.service_id=ANY(services) AND role IN ('agent','manager','hod','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ASSIGNEE';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=target.id AND status IN ('called','serving') AND id<>t.id) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.tickets SET status='waiting',called_at=NULL,escalated=true WHERE id=t.id;
  PERFORM qms.assign_ticket(t.id,target.id,'manager_reassignment',p_actor);
 ELSIF p_action='call' THEN
  IF t.status<>'waiting' THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  IF NOT(t.service_id=ANY(u.services)) AND NOT coalesce(privileged AND u.sf_id=t.manager_sf_id AND t.service_id='collection',false) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF NOT u.online OR u.last_seen<=now()-interval '45 seconds' THEN RAISE EXCEPTION 'AGENT_UNAVAILABLE';END IF;
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
END $function$;
