CREATE OR REPLACE FUNCTION qms.set_presence(p_user uuid,p_online boolean,p_counter text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT p_online AND EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_user AND status IN ('called','serving')) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 UPDATE qms.users SET online=p_online,last_seen=now(),counter=coalesce(p_counter,counter) WHERE id=p_user AND enabled;
END $$;
CREATE OR REPLACE FUNCTION qms.save_user(p_id uuid,p_actor uuid,p_username text,p_name text,p_role text,p_sf_id text,p_manager_sf_id text,p_services text[],p_counter text,p_enabled boolean,p_password text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role='admin' AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id=p_actor AND (p_role<>'admin' OR NOT p_enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_id AND status IN ('called','serving') AND (NOT p_enabled OR p_role NOT IN ('admin','hod','manager','agent') OR NOT(service_id=ANY(p_services)))) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.users SET username=p_username,name=p_name,role=p_role,sf_id=p_sf_id,manager_sf_id=p_manager_sf_id,services=p_services,counter=p_counter,enabled=p_enabled,password_hash=coalesce(p_password,password_hash),must_change_password=CASE WHEN p_password IS NOT NULL THEN true ELSE must_change_password END,online=CASE WHEN NOT p_enabled THEN false ELSE online END WHERE id=p_id RETURNING id INTO uid;
  IF p_password IS NOT NULL OR NOT p_enabled THEN DELETE FROM qms.sessions WHERE user_id=p_id;END IF;
 ELSE
  IF p_password IS NULL THEN RAISE EXCEPTION 'PASSWORD_REQUIRED';END IF;
  INSERT INTO qms.users(username,name,role,sf_id,manager_sf_id,services,counter,enabled,password_hash) VALUES(p_username,p_name,p_role,p_sf_id,p_manager_sf_id,p_services,p_counter,p_enabled,p_password) RETURNING id INTO uid;
 END IF;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'team_updated',jsonb_build_object('id',uid,'username',p_username));
 RETURN uid;
END $$;
CREATE OR REPLACE FUNCTION qms.queue_salesforce_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO qms.outbox(ticket_id,kind,status) VALUES(NEW.id,'salesforce','pending') ON CONFLICT(ticket_id,kind) DO UPDATE SET revision=qms.outbox.revision+1,status=CASE WHEN qms.outbox.status='processing' THEN 'processing' ELSE 'pending' END,attempts=CASE WHEN qms.outbox.status='processing' THEN qms.outbox.attempts ELSE 0 END,available_at=now();
 RETURN NEW;
END $$;
CREATE TRIGGER tickets_salesforce_outbox AFTER INSERT OR UPDATE OF status,assigned_to,comments ON qms.tickets FOR EACH ROW EXECUTE FUNCTION qms.queue_salesforce_change();
