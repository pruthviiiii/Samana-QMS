CREATE TABLE qms.service_groups (
 service_id text PRIMARY KEY REFERENCES qms.services(id),
 sf_group_id text NOT NULL,
 sf_group_name text NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION qms.sync_service_group(p_service text,p_group text,p_name text,p_members text[],p_actor uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(1947301);
 IF NOT EXISTS(SELECT 1 FROM qms.users WHERE id=p_actor AND role='admin' AND enabled) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT 1 FROM qms.services WHERE id=p_service) THEN RAISE EXCEPTION 'INVALID_SERVICE';END IF;
 IF EXISTS(SELECT 1 FROM qms.tickets t JOIN qms.users u ON u.id=t.assigned_to WHERE t.service_id=p_service AND t.status IN ('called','serving') AND u.sf_id IS NOT NULL AND NOT(u.sf_id=ANY(p_members))) THEN RAISE EXCEPTION 'AGENT_BUSY';END IF;
 UPDATE qms.users SET services=CASE WHEN sf_id=ANY(p_members) THEN ARRAY(SELECT DISTINCT unnest(services||ARRAY[p_service])) ELSE array_remove(services,p_service) END WHERE sf_id IS NOT NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 INSERT INTO qms.service_groups(service_id,sf_group_id,sf_group_name) VALUES(p_service,p_group,p_name) ON CONFLICT(service_id) DO UPDATE SET sf_group_id=excluded.sf_group_id,sf_group_name=excluded.sf_group_name,synced_at=now();
 INSERT INTO qms.events(actor_id,action,details) VALUES(p_actor,'service_group_synced',jsonb_build_object('service',p_service,'group',p_group,'members',cardinality(p_members)));
 RETURN (SELECT count(*)::int FROM qms.users WHERE sf_id=ANY(p_members));
END $$;
