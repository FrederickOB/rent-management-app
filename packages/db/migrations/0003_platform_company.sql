-- The platform company (kind 'platform') owns person-level audit events: sign-ins by people
-- with no membership, such as tenants before their tenancy exists (M1 plan, section 4.5).
CREATE FUNCTION app.platform_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM company WHERE kind = 'platform' AND status = 'active' ORDER BY created_at LIMIT 1
$$;
ALTER FUNCTION app.platform_company_id() OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.platform_company_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_company_id() TO rent_app;
