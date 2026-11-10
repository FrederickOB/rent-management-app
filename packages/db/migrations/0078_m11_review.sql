-- M11 review round (backend lead): approval eligibility on new requests (B9), anonymised tenants
-- kept anonymous (B8), and a tenant's person matched only on a proven phone (B-M1, identity's
-- design). Applied as rent_owner, after 0077.
--
-- Error codes: RA018 (as 0068) a request made through the application without its eligible
-- approvers; RA127 a personal field of an anonymised tenant or contact refilled.

-- 1. B9: every request made through the application names who may decide it (the approvals
-- engine always does). A request without the list is refused unless the system makes it (fixtures
-- and migrations), so RA018 can never be skipped for a request a person raised.
CREATE FUNCTION app.check_approval_request_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.eligible_approvers IS NULL AND coalesce(app.current_actor_kind(), '') IN ('staff', 'platform_admin', 'tenant') THEN
    RAISE EXCEPTION 'an approval request names who may decide it (AD-05)' USING ERRCODE = 'RA018';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eligible_named BEFORE INSERT ON approval_request
  FOR EACH ROW EXECUTE FUNCTION app.check_approval_request_insert();
--> statement-breakpoint

-- 2. B8: an anonymised tenant or contact stays anonymous: its personal fields never change again
-- (RA126 already keeps anonymised_at). Archiving and the test-contact flag still may.
CREATE FUNCTION app.check_anonymised_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_free text[] := ARRAY['archived_at', 'updated_at', 'is_test_contact', 'anonymised_at'];
BEGIN
  IF OLD.anonymised_at IS NOT NULL
     AND (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'an anonymised record''s personal fields never change' USING ERRCODE = 'RA127';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER anonymised_fields BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION app.check_anonymised_fields();
CREATE TRIGGER anonymised_fields BEFORE UPDATE ON tenant_contact
  FOR EACH ROW EXECUTE FUNCTION app.check_anonymised_fields();
REVOKE ALL ON FUNCTION app.check_approval_request_insert(), app.check_anonymised_fields() FROM PUBLIC;
--> statement-breakpoint

-- 3. B-M1 (identity's design): a tenant is linked to a person only on a phone that person proved,
-- or to a phone-only person (placeholder email, no password). An unproved phone on someone else's
-- record is released first, so a landlord's invite can never steer another landlord's tenant to
-- the wrong person. Same signature, owner and grants as 0007.
CREATE OR REPLACE FUNCTION app.ensure_tenant_person(p_phone text, p_name text DEFAULT NULL, p_test_contact boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF app.current_company_id() IS NULL THEN
    RAISE EXCEPTION 'tenants are linked to people inside a company transaction' USING ERRCODE = 'RA029';
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{6,14}$' THEN
    RAISE EXCEPTION 'a tenant person needs an E.164 phone number' USING ERRCODE = 'RA029';
  END IF;
  SELECT p.id INTO v_id FROM person p
  WHERE p.phone_number = p_phone
    AND (p.phone_number_verified IS TRUE
         OR (p.email LIKE '%@users.invalid'
             AND NOT EXISTS (SELECT 1 FROM account a WHERE a.user_id = p.id AND a.provider_id = 'credential')));
  IF v_id IS NULL THEN
    UPDATE person SET phone_number = NULL, phone_number_verified = NULL, updated_at = now()
    WHERE phone_number = p_phone AND phone_number_verified IS NOT TRUE;
    v_id := uuidv7();
    INSERT INTO person (id, name, email, email_verified, phone_number, phone_number_verified, is_test_contact)
    VALUES (v_id, coalesce(nullif(btrim(p_name), ''), 'Tenant'), 'phone-' || v_id || '@users.invalid', false,
            p_phone, false, coalesce(p_test_contact, false))
    ON CONFLICT (phone_number) DO NOTHING;
    SELECT id INTO v_id FROM person WHERE phone_number = p_phone;
  END IF;
  RETURN v_id;
END $$;
GRANT SELECT ON account TO rent_system;
GRANT UPDATE (phone_number, phone_number_verified, updated_at) ON person TO rent_system;
