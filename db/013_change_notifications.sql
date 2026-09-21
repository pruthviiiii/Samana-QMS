-- Live screens. Any change to a ticket, an assignment notification or a staff
-- member's availability raises NOTIFY qms_changes; the web server forwards it
-- to connected consoles and TVs as a server-sent event, so screens refresh when
-- something happened instead of asking every few seconds.
CREATE OR REPLACE FUNCTION qms.notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('qms_changes',TG_TABLE_NAME);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tickets_notify ON qms.tickets;
CREATE TRIGGER tickets_notify AFTER INSERT OR UPDATE ON qms.tickets FOR EACH STATEMENT EXECUTE FUNCTION qms.notify_change();
DROP TRIGGER IF EXISTS notifications_notify ON qms.notifications;
CREATE TRIGGER notifications_notify AFTER INSERT OR UPDATE ON qms.notifications FOR EACH STATEMENT EXECUTE FUNCTION qms.notify_change();
-- Heartbeats rewrite the same availability every 30 seconds; only a real
-- change of state, services, counter or enabled flag is announced.
DROP TRIGGER IF EXISTS users_presence_notify ON qms.users;
CREATE TRIGGER users_presence_notify AFTER UPDATE ON qms.users FOR EACH ROW
 WHEN (OLD.online IS DISTINCT FROM NEW.online OR OLD.services IS DISTINCT FROM NEW.services OR OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.counter IS DISTINCT FROM NEW.counter)
 EXECUTE FUNCTION qms.notify_change();
