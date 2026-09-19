CREATE SEQUENCE qms.round_robin_position;
ALTER TABLE qms.round_robin ADD COLUMN position bigint NOT NULL DEFAULT nextval('qms.round_robin_position');
ALTER TABLE qms.users ADD COLUMN email text;
CREATE OR REPLACE FUNCTION qms.assign_ticket(p_ticket uuid,p_user uuid,p_reason text,p_actor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior uuid;
BEGIN
 SELECT assigned_to INTO prior FROM qms.tickets WHERE id=p_ticket;
 UPDATE qms.tickets SET assigned_to=p_user,assigned_at=CASE WHEN p_user IS NULL THEN NULL ELSE now() END,routing_reason=p_reason,version=version+1 WHERE id=p_ticket;
 IF p_user IS DISTINCT FROM prior THEN
  INSERT INTO qms.events(ticket_id,actor_id,action,details) VALUES(p_ticket,p_actor,'assigned',jsonb_build_object('from',prior,'to',p_user,'reason',p_reason));
  IF p_user IS NOT NULL THEN
   INSERT INTO qms.notifications(user_id,ticket_id) VALUES(p_user,p_ticket);
   INSERT INTO qms.round_robin(service_id,user_id,last_assigned,position) SELECT service_id,p_user,clock_timestamp(),nextval('qms.round_robin_position') FROM qms.tickets WHERE id=p_ticket ON CONFLICT(service_id,user_id) DO UPDATE SET last_assigned=excluded.last_assigned,position=excluded.position;
  END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION qms.choose_available(p_service text,p_exclude uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $$
 SELECT u.id FROM qms.users u LEFT JOIN qms.round_robin rr ON rr.service_id=p_service AND rr.user_id=u.id
 WHERE u.enabled AND u.online AND u.last_seen>now()-interval '90 seconds' AND u.role IN ('agent','manager','hod','admin') AND p_service=ANY(u.services) AND (p_exclude IS NULL OR u.id<>p_exclude)
 AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('called','serving'))
 ORDER BY rr.position ASC NULLS FIRST,u.created_at,u.id LIMIT 1
$$;

