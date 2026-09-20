-- Sign-in by email and administrator-managed email addresses.
-- Adds a 12-parameter qms.save_user that also stores an email. The 11-parameter
-- version from 003 stays in place for code deployed before this migration.
CREATE INDEX IF NOT EXISTS users_email_lower ON qms.users(lower(email)) WHERE email IS NOT NULL;

CREATE OR REPLACE FUNCTION qms.save_user(p_id uuid,p_actor uuid,p_username text,p_name text,p_role text,p_sf_id text,p_manager_sf_id text,p_services text[],p_counter text,p_enabled boolean,p_password text,p_email text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid; v_email text;
BEGIN
 v_email:=nullif(lower(trim(p_email)),'');
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role='admin' AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id=p_actor AND (p_role<>'admin' OR NOT p_enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF p_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND';END IF;
  IF EXISTS(SELECT 1 FROM qms.tickets WHERE assigned_to=p_id AND status IN ('called','serving') AND (NOT p_enabled OR p_role NOT IN ('admin','hod','manager','agent') OR NOT(service_id=ANY(p_services)))) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
  UPDATE qms.users SET username=p_username,name=p_name,email=v_email,role=p_role,sf_id=p_sf_id,manager_sf_id=p_manager_sf_id,services=p_services,counter=p_counter,enabled=p_enabled,password_hash=coalesce(p_password,password_hash),must_change_password=CASE WHEN p_password IS NOT NULL THEN true ELSE must_change_password END,online=CASE WHEN NOT p_enabled THEN false ELSE online END WHERE id=p_id RETURNING id INTO uid;
  IF p_password IS NOT NULL OR NOT p_enabled THEN DELETE FROM qms.sessions WHERE user_id=p_id;END IF;
 ELSE
  IF p_password IS NULL THEN RAISE EXCEPTION 'PASSWORD_REQUIRED';END IF;
  INSERT INTO qms.users(username,name,email,role,sf_id,manager_sf_id,services,counter,enabled,password_hash) VALUES(p_username,p_name,v_email,p_role,p_sf_id,p_manager_sf_id,p_services,p_counter,p_enabled,p_password) RETURNING id INTO uid;
 END IF;
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'team_updated',jsonb_build_object('id',uid,'username',p_username));
 RETURN uid;
END $$;
