-- Coordinate logins, password changes, and administrator resets on the user row.
-- A password verified before a concurrent reset must never create a new session.
CREATE OR REPLACE FUNCTION qms.issue_session(p_user uuid,p_verified_hash text,p_token_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE current_hash text; allowed boolean;
BEGIN
 SELECT password_hash,enabled INTO current_hash,allowed FROM qms.users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT allowed OR current_hash IS DISTINCT FROM p_verified_hash THEN RETURN false; END IF;
 INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES(p_token_hash,p_user,now()+interval '8 hours');
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION qms.change_password(p_user uuid,p_verified_hash text,p_new_hash text,p_token_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE current_hash text; allowed boolean;
BEGIN
 SELECT password_hash,enabled INTO current_hash,allowed FROM qms.users WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR NOT allowed OR current_hash IS DISTINCT FROM p_verified_hash THEN RETURN false; END IF;
 UPDATE qms.users SET password_hash=p_new_hash,must_change_password=false WHERE id=p_user;
 DELETE FROM qms.sessions WHERE user_id=p_user;
 INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES(p_token_hash,p_user,now()+interval '8 hours');
 INSERT INTO qms.events(actor_id,action) VALUES(p_user,'password_changed');
 RETURN true;
END $$;
