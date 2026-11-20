-- M11 decision 5: anonymising a tenant in place. Applied as rent_owner, after 0070.
--
-- The tenant and contact rows stay (leases, money and notices refer to them); an erasure request
-- clears their personal fields, where the record's retention rule is verified and its period has
-- passed, and records when. anonymised_at is set once and never cleared.

GRANT UPDATE (anonymised_at) ON tenant, tenant_contact TO rent_app;

CREATE FUNCTION app.check_anonymised_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.anonymised_at IS NOT NULL AND NEW.anonymised_at IS DISTINCT FROM OLD.anonymised_at THEN
    RAISE EXCEPTION 'an anonymised record stays anonymised' USING ERRCODE = 'RA126';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER anonymised_once BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION app.check_anonymised_once();
CREATE TRIGGER anonymised_once BEFORE UPDATE ON tenant_contact
  FOR EACH ROW EXECUTE FUNCTION app.check_anonymised_once();
REVOKE ALL ON FUNCTION app.check_anonymised_once() FROM PUBLIC;
