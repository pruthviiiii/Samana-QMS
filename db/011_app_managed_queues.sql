-- Queues are managed in the app and stored here only. Nothing about queues is
-- read from or written to Salesforce.
DROP FUNCTION IF EXISTS qms.sync_service_group(text,text,text,text[],uuid);
DROP TABLE IF EXISTS qms.service_groups;

-- Add or remove one member of one service queue. Administrators, HODs and
-- managers may edit; an agent serving a ticket of that service cannot be removed.
CREATE OR REPLACE FUNCTION qms.set_queue_member(p_service text,p_user uuid,p_member boolean,p_actor uuid) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE result text[];
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role IN ('admin','hod','manager') AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT 1 FROM qms.services WHERE id=p_service) THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_user AND role IN ('admin','hod','manager','agent')) THEN RAISE EXCEPTION 'USER_NOT_FOUND';END IF;
 IF NOT p_member AND EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND service_id=p_service AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 UPDATE qms.users
  SET services=CASE WHEN p_member THEN ARRAY(SELECT DISTINCT s FROM unnest(services||ARRAY[p_service]) AS s ORDER BY s) ELSE array_remove(services,p_service) END
  WHERE id=p_user RETURNING services INTO result;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'queue_updated',jsonb_build_object('service',p_service,'user',p_user,'member',p_member));
 RETURN result;
END $$;

-- Remove staff rows created by the former bulk import that were never activated
-- and are referenced nowhere. Anyone enabled, given a password, or linked to a
-- ticket, event, session, notification, rotation or lookup is kept.
DELETE FROM qms.users u
WHERE u.username LIKE 'sf-%' AND NOT u.enabled AND u.password_hash IS NULL
  AND NOT EXISTS(SELECT 1 FROM qms.tickets t WHERE t.assigned_to=u.id OR t.created_by=u.id)
  AND NOT EXISTS(SELECT 1 FROM qms.events e WHERE e.actor_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM qms.sessions s WHERE s.user_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM qms.notifications n WHERE n.user_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM qms.round_robin r WHERE r.user_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM qms.lookups l WHERE l.actor_id=u.id);
