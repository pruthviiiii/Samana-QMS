-- 017: the queue engine's fairness, urgency and lock behaviour.
--
-- Six changes, all in the routing path:
--
-- 1. One definition of the presence window and of each role group, so a value
--    used by several functions is written once (qms.presence_window(),
--    qms.serving_roles(), qms.manager_roles()). lib/domain.ts holds the same
--    lists for the application and tests/schema.test.ts checks the two agree.
--
-- 2. Services carry a priority. A waiting ticket in a higher-priority service
--    is routed before an older one in a lower-priority service, so a refund can
--    be put ahead of a general enquiry. Priority never reorders tickets inside
--    one service: there, arrival order still decides.
--
-- 3. Fairness is per person, not per counter. qms.round_robin kept a separate
--    cursor for every service, so work done at one counter counted for nothing
--    at the others and whoever covered the most services was handed the most
--    customers. One cursor now lives on the person (qms.users.rotation) and is
--    moved to the back on every assignment, whichever service it came from.
--    The cursor is set when the account is created, so somebody added to a
--    queue joins the back of the rotation instead of the front.
--
-- 4. An agent holds one customer at a time. qms.choose_available treated a
--    person as free until they had actually called someone, so ten waiting
--    customers could all be given the same agent's name. It now skips anyone
--    who already holds a waiting, called or serving ticket. To keep that from
--    adding a wait, closing a ticket immediately offers that agent the next
--    customer (qms.offer_next) instead of leaving them idle until the next tick.
--
-- 5. The preferred unit owner still wins, but only for one customer at a time.
--    A busy owner may hold one customer for the five-minute window; a second
--    goes to the rotation rather than queueing on one person.
--
-- 6. The routing sweep no longer holds the global lock across the whole queue.
--    qms.route_waiting(limit, offset) routes a bounded batch per call and
--    lib/data/functions.ts calls it repeatedly, so the lock is released between
--    batches and ticket actions and heartbeats interleave with the sweep.
--    Heartbeats no longer take the global lock at all: qms.set_presence locks
--    the one account row it writes.

-- 1. Shared definitions -----------------------------------------------------

-- The silence after which an agent counts as gone. The browser heartbeat runs
-- every 15 seconds (components/qms/use-workspace.ts), so this is three beats.
CREATE OR REPLACE FUNCTION qms.presence_window()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT interval '45 seconds' $function$;

-- Roles that can hold and serve a customer. Mirrors SERVING_ROLES.
CREATE OR REPLACE FUNCTION qms.serving_roles()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT ARRAY['admin','hod','manager','agent'] $function$;

-- Roles that oversee other people's work. Mirrors MANAGER_ROLES.
CREATE OR REPLACE FUNCTION qms.manager_roles()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT ARRAY['admin','hod','manager'] $function$;

-- 2. Service priority -------------------------------------------------------

ALTER TABLE qms.services ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE qms.services DROP CONSTRAINT IF EXISTS services_priority_range;
ALTER TABLE qms.services ADD CONSTRAINT services_priority_range CHECK (priority BETWEEN 0 AND 9);

-- 3. One fairness cursor per person ------------------------------------------

-- A new account starts at the back of the rotation rather than at the front.
ALTER TABLE qms.users ADD COLUMN IF NOT EXISTS rotation bigint NOT NULL
  DEFAULT nextval('qms.round_robin_position');

-- Carry the old per-service cursors over: the most recent assignment anywhere
-- becomes the person's position, so nobody's place changes on deployment.
UPDATE qms.users u
   SET rotation = greatest(u.rotation, c.position)
  FROM (SELECT user_id, max(position) position FROM qms.round_robin GROUP BY user_id) c
 WHERE c.user_id = u.id;

DROP TABLE IF EXISTS qms.round_robin;

-- The sequence was created standalone in migration 005, so it outlives the
-- table; rename it after what it now numbers. Column defaults hold the
-- sequence by OID and follow the rename on their own, but the name written
-- into qms.assign_ticket below does not, so that function names the new one.
ALTER SEQUENCE IF EXISTS qms.round_robin_position RENAME TO rotation_position;

CREATE INDEX IF NOT EXISTS users_rotation ON qms.users (rotation)
  WHERE enabled AND online;

-- Waiting tickets are read in priority order on every sweep and on every close.
CREATE INDEX IF NOT EXISTS tickets_waiting_unassigned
  ON qms.tickets (service_id, created_at) WHERE status = 'waiting';

-- 4. Assignment moves the person to the back of the one rotation -------------

CREATE OR REPLACE FUNCTION qms.assign_ticket(p_ticket uuid, p_user uuid, p_reason text, p_actor uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE prior uuid;
BEGIN
 SELECT assigned_to INTO prior FROM qms.tickets WHERE id=p_ticket;
 UPDATE qms.tickets SET assigned_to=p_user,assigned_at=CASE WHEN p_user IS NULL THEN NULL ELSE now() END,routing_reason=p_reason,version=version+1 WHERE id=p_ticket;
 IF p_user IS DISTINCT FROM prior THEN
  UPDATE qms.notifications SET read_at=now() WHERE ticket_id=p_ticket AND user_id IS DISTINCT FROM p_user AND read_at IS NULL;
  INSERT INTO qms.events(ticket_id,actor_id,action,details) VALUES(p_ticket,p_actor,'assigned',jsonb_build_object('from',prior,'to',p_user,'reason',p_reason));
  IF p_user IS NOT NULL THEN
   INSERT INTO qms.notifications(user_id,ticket_id) VALUES(p_user,p_ticket);
   -- One cursor for the person, not one per service: a customer taken at any
   -- counter moves them to the back of every queue they cover.
   UPDATE qms.users SET rotation=nextval('qms.rotation_position') WHERE id=p_user;
  END IF;
 END IF;
END $function$;

-- 5. One customer at a time, ordered by the person's own rotation ------------

CREATE OR REPLACE FUNCTION qms.choose_available(p_service text, p_exclude uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE sql
AS $function$
 SELECT u.id FROM qms.users u
 WHERE u.enabled AND u.online AND u.last_seen>now()-qms.presence_window()
   AND u.role=ANY(qms.serving_roles()) AND p_service=ANY(u.services)
   AND (p_exclude IS NULL OR u.id<>p_exclude)
   -- Already holding a customer, whether or not they have called them yet.
   AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('waiting','called','serving'))
 ORDER BY u.rotation,u.created_at,u.id LIMIT 1
$function$;

-- Offers a free agent the next customer they can take, highest priority first
-- and oldest within a priority. Called when a ticket closes so that holding one
-- customer at a time costs nobody a wait for the next routing tick.
CREATE OR REPLACE FUNCTION qms.offer_next(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE u qms.users; candidate uuid;
BEGIN
 SELECT * INTO u FROM qms.users
  WHERE id=p_user AND enabled AND online AND last_seen>now()-qms.presence_window()
    AND role=ANY(qms.serving_roles());
 IF NOT FOUND THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND status IN ('waiting','called','serving')) THEN RETURN; END IF;
 SELECT t.id INTO candidate FROM qms.tickets t JOIN qms.services s ON s.id=t.service_id
  WHERE t.status='waiting' AND t.assigned_to IS NULL AND t.service_id=ANY(u.services)
  ORDER BY s.priority DESC,t.created_at LIMIT 1;
 IF candidate IS NOT NULL THEN PERFORM qms.assign_ticket(candidate,p_user,'agent_free'); END IF;
END $function$;

-- 6. Routing ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION qms.route_ticket(p_ticket uuid, p_initial boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE t qms.tickets; owner_user qms.users; assigned_user qms.users; candidate uuid; manager_user qms.users; owner_eligible boolean; owner_free boolean; owner_holdable boolean;
BEGIN
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;
 IF t.status<>'waiting' THEN RETURN; END IF;
 SELECT * INTO owner_user FROM qms.users WHERE sf_id=t.owner_sf_id AND enabled AND role=ANY(qms.serving_roles());
 owner_eligible:=owner_user.id IS NOT NULL AND owner_user.online AND owner_user.last_seen>now()-qms.presence_window() AND t.service_id=ANY(owner_user.services);
 -- The customer's own relationship manager wins, but for one customer at a
 -- time: free, they take it now; mid-service, they may hold one for the
 -- five-minute window; already holding one, it goes to the rotation.
 owner_free:=owner_eligible AND NOT EXISTS(SELECT 1 FROM qms.tickets o WHERE o.assigned_to=owner_user.id AND o.status IN ('waiting','called','serving'));
 owner_holdable:=owner_eligible AND NOT EXISTS(SELECT 1 FROM qms.tickets o WHERE o.assigned_to=owner_user.id AND o.status='waiting');
 IF (p_initial OR (t.assigned_to IS NULL AND NOT t.escalated)) AND (owner_free OR owner_holdable) THEN
  PERFORM qms.assign_ticket(t.id,owner_user.id,CASE WHEN owner_free THEN 'preferred_owner' ELSE 'owner_busy_five_minute_hold' END);
  RETURN;
 END IF;
 IF NOT p_initial AND t.assigned_to IS NOT NULL THEN
  SELECT * INTO assigned_user FROM qms.users WHERE id=t.assigned_to;
  IF t.escalated AND t.service_id='collection' AND assigned_user.enabled AND assigned_user.role=ANY(qms.manager_roles()) AND assigned_user.sf_id=t.manager_sf_id THEN RETURN; END IF;
  IF assigned_user.enabled AND t.service_id=ANY(assigned_user.services) AND assigned_user.online AND assigned_user.last_seen>now()-qms.presence_window() AND now()<=coalesce(t.assigned_at,t.created_at)+interval '5 minutes' THEN RETURN; END IF;
 END IF;
 IF t.service_id='collection' THEN
  SELECT * INTO manager_user FROM qms.users WHERE sf_id=t.manager_sf_id AND enabled AND role=ANY(qms.manager_roles());
  IF manager_user.id IS NOT NULL THEN
   PERFORM qms.assign_ticket(t.id,manager_user.id,CASE WHEN manager_user.online AND manager_user.last_seen>now()-qms.presence_window() THEN 'escalated_to_manager' ELSE 'manager_offline_attention_required' END);
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
   IF t.assigned_to IS NOT NULL AND (NOT assigned_user.enabled OR NOT(t.service_id=ANY(assigned_user.services)) OR NOT assigned_user.online OR assigned_user.last_seen<=now()-qms.presence_window()) THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent');
   ELSIF t.assigned_to IS NULL AND t.routing_reason<>'no_available_agent' THEN PERFORM qms.assign_ticket(t.id,NULL,'no_available_agent'); END IF;
  END IF;
 END IF;
END $function$;

-- Everything the sweep does that is not routing one ticket. Bounded work: bulk
-- statements, no loop, so the global lock is held briefly.
CREATE OR REPLACE FUNCTION qms.route_maintenance()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 -- Day rollover: a ticket left waiting or called from a previous Dubai day is
 -- a no-show once it is more than two hours old. Serving tickets are left to
 -- the agent to complete.
 WITH stale AS (UPDATE qms.tickets SET status='no_show',closed_at=now(),version=version+1 WHERE status IN ('waiting','called') AND day<(now() AT TIME ZONE 'Asia/Dubai')::date AND created_at<now()-interval '2 hours' RETURNING id)
 INSERT INTO qms.events(ticket_id,action,details) SELECT id,'no_show','{"reason":"day_rollover"}'::jsonb FROM stale;
 WITH expired AS (UPDATE qms.users SET online=false WHERE online AND last_seen<now()-qms.presence_window() RETURNING id)
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
   AND NOT EXISTS(SELECT 1 FROM qms.notifications n WHERE n.user_id=u.id);
END $function$;

-- Routes one bounded batch of waiting tickets, highest priority first and
-- oldest within a priority. The caller advances p_offset by the number it has
-- already processed: routing a ticket assigns it but leaves it waiting, so the
-- ordering is stable across calls. Each call is its own transaction in
-- production, so the global lock is released between batches.
CREATE OR REPLACE FUNCTION qms.route_waiting(p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE item record; total integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 FOR item IN
  SELECT t.id FROM qms.tickets t JOIN qms.services s ON s.id=t.service_id
   WHERE t.status='waiting'
   ORDER BY s.priority DESC,t.created_at,t.id
   LIMIT greatest(p_limit,1) OFFSET greatest(p_offset,0)
 LOOP
  PERFORM qms.route_ticket(item.id,false);total:=total+1;
 END LOOP;
 RETURN total;
END $function$;

/** Records that the scheduler ran; health/alerts reads this. */
CREATE OR REPLACE FUNCTION qms.note_worker_run(p_checked integer)
 RETURNS void
 LANGUAGE sql
AS $function$
 INSERT INTO qms.system_state(key,value) VALUES('worker',jsonb_build_object('lastRun',now(),'checked',p_checked))
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()
$function$;

-- The whole sweep in one transaction. lib/data/functions.ts runs the three
-- steps separately so the lock is released between batches; this composition
-- stays for tests and for scripts/load-check.mjs, which measure one sweep.
CREATE OR REPLACE FUNCTION qms.route_due()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE total integer:=0; done integer;
BEGIN
 PERFORM qms.route_maintenance();
 LOOP
  done:=qms.route_waiting(200,total);
  total:=total+done;
  EXIT WHEN done<200 OR total>20000;
 END LOOP;
 PERFORM qms.note_worker_run(total);
 RETURN total;
END $function$;

-- 7. Heartbeats leave the global lock alone ----------------------------------

CREATE OR REPLACE FUNCTION qms.set_presence(p_user uuid, p_online boolean, p_counter text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE was boolean; allowed boolean;
BEGIN
 -- The one account row, not the global lock: every agent sends this every 15
 -- seconds and must not queue behind the routing sweep. Routing may therefore
 -- read an agent as online in the instant they go offline; the next sweep
 -- moves that customer on, which is what already happens for a dead screen.
 SELECT online,enabled INTO was,allowed FROM qms.users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT allowed THEN RETURN;END IF;
 IF NOT p_online AND EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 UPDATE qms.users SET online=p_online,last_seen=now(),counter=coalesce(p_counter,counter) WHERE id=p_user;
 IF was IS DISTINCT FROM p_online THEN
  INSERT INTO qms.events(actor_id,action) VALUES(p_user,CASE WHEN p_online THEN 'presence_online' ELSE 'presence_offline' END);
 END IF;
END $function$;

-- 8. The remaining hand-written role lists and presence windows --------------

CREATE OR REPLACE FUNCTION qms.set_queue_member(p_service text, p_user uuid, p_member boolean, p_actor uuid)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE result text[];
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role=ANY(qms.manager_roles()) AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT 1 FROM qms.services WHERE id=p_service) THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_user AND role=ANY(qms.serving_roles())) THEN RAISE EXCEPTION 'USER_NOT_FOUND';END IF;
 IF NOT p_member AND EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND service_id=p_service AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 UPDATE qms.users
  SET services=CASE WHEN p_member THEN ARRAY(SELECT DISTINCT s FROM unnest(services||ARRAY[p_service]) AS s ORDER BY s) ELSE array_remove(services,p_service) END
  WHERE id=p_user RETURNING services INTO result;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'queue_updated',jsonb_build_object('service',p_service,'user',p_user,'member',p_member));
 RETURN result;
END $function$;

/** Sets how urgently a service is routed; 0 is normal and 9 is most urgent. */
CREATE OR REPLACE FUNCTION qms.set_service_priority(p_service text, p_priority integer, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE result integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role=ANY(qms.manager_roles()) AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE qms.services SET priority=p_priority WHERE id=p_service RETURNING priority INTO result;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'queue_updated',jsonb_build_object('service',p_service,'priority',p_priority));
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION qms.ticket_action(p_ticket uuid, p_action text, p_actor uuid, p_version integer, p_comment text DEFAULT NULL::text, p_target uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE t qms.tickets; u qms.users; target qms.users; privileged boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 SELECT * INTO t FROM qms.tickets WHERE id=p_ticket FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'TICKET_NOT_FOUND';END IF;
 SELECT * INTO u FROM qms.users WHERE id=p_actor AND enabled;privileged:=u.role=ANY(qms.manager_roles());
 IF u.id IS NULL OR NOT(u.role=ANY(qms.serving_roles())) OR (NOT privileged AND t.assigned_to IS DISTINCT FROM u.id) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF t.version<>p_version THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 IF p_action='reassign' THEN
  IF NOT privileged THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF t.status NOT IN ('waiting','called') THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  SELECT * INTO target FROM qms.users WHERE id=p_target AND enabled AND online AND last_seen>now()-qms.presence_window() AND t.service_id=ANY(services) AND role=ANY(qms.serving_roles());
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ASSIGNEE';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=target.id AND status IN ('called','serving') AND id<>t.id) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.tickets SET status='waiting',called_at=NULL,escalated=true WHERE id=t.id;
  PERFORM qms.assign_ticket(t.id,target.id,'manager_reassignment',p_actor);
 ELSIF p_action='call' THEN
  IF t.status<>'waiting' THEN RAISE EXCEPTION 'INVALID_TRANSITION';END IF;
  IF NOT(t.service_id=ANY(u.services)) AND NOT coalesce(privileged AND u.sf_id=t.manager_sf_id AND t.service_id='collection',false) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  IF NOT u.online OR u.last_seen<=now()-qms.presence_window() THEN RAISE EXCEPTION 'AGENT_UNAVAILABLE';END IF;
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
 -- The agent who just finished holds nobody: offer them the next customer now
 -- rather than leaving them idle until the next routing tick.
 IF p_action IN ('close','no_show') AND t.assigned_to IS NOT NULL THEN
  PERFORM qms.offer_next(t.assigned_to);
 END IF;
 RETURN (SELECT to_jsonb(v) FROM qms.ticket_view v WHERE id=t.id);
END $function$;

CREATE OR REPLACE FUNCTION qms.save_user(p_id uuid, p_actor uuid, p_username text, p_name text, p_role text, p_sf_id text, p_manager_sf_id text, p_services text[], p_counter text, p_enabled boolean, p_password text, p_email text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE uid uuid; v_email text;
BEGIN
 v_email:=nullif(lower(trim(p_email)),'');
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role='admin' AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id=p_actor AND (p_role<>'admin' OR NOT p_enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_id AND status IN ('called','serving') AND (NOT p_enabled OR NOT(p_role=ANY(qms.serving_roles())) OR NOT(service_id=ANY(p_services)))) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.users SET username=p_username,name=p_name,email=v_email,role=p_role,sf_id=p_sf_id,manager_sf_id=p_manager_sf_id,services=p_services,counter=p_counter,enabled=p_enabled,password_hash=coalesce(p_password,password_hash),must_change_password=CASE WHEN p_password IS NOT NULL THEN true ELSE must_change_password END,online=CASE WHEN NOT p_enabled THEN false ELSE online END WHERE id=p_id RETURNING id INTO uid;
  IF p_password IS NOT NULL OR NOT p_enabled THEN DELETE FROM qms.sessions WHERE user_id=p_id;END IF;
 ELSE
  IF p_password IS NULL THEN RAISE EXCEPTION 'PASSWORD_REQUIRED';END IF;
  INSERT INTO qms.users(username,name,email,role,sf_id,manager_sf_id,services,counter,enabled,password_hash) VALUES(p_username,p_name,v_email,p_role,p_sf_id,p_manager_sf_id,p_services,p_counter,p_enabled,p_password) RETURNING id INTO uid;
 END IF;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'team_updated',jsonb_build_object('id',uid,'username',p_username));
 RETURN uid;
END $function$;

-- The eleven-argument overload predates the email column and nothing calls it.
DROP FUNCTION IF EXISTS qms.save_user(uuid, uuid, text, text, text, text, text, text[], text, boolean, text);
