-- The app role must not rewrite the audit trail or physically delete data (v1 has no hard delete).
-- It keeps: UPDATE on entities/entity_proposals (writes, decisions) and DELETE on relations (unlink).
-- Guarded so environments without the fluxie_app role (e.g. a superuser-only setup) still migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fluxie_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON change_log FROM fluxie_app;
    REVOKE DELETE, TRUNCATE ON entities, entity_proposals, spaces FROM fluxie_app;
  END IF;
END
$$;
