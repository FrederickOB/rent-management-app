-- M11 review round B8, refined: an anonymised tenant's identity numbers may still be cleared
-- (to null, or id_status to 'none') once their own retention period passes, never set or changed
-- to anything else. Every other personal field stays frozen (RA127). Applied as rent_owner, after
-- 0079.
CREATE OR REPLACE FUNCTION app.check_anonymised_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_free text[] := ARRAY['archived_at', 'updated_at', 'is_test_contact', 'anonymised_at'];
  v_clearable text[] := ARRAY['id_type', 'id_number_encrypted', 'id_number_index', 'id_number_masked',
    'id_status', 'id_verified_at', 'tin_encrypted', 'tin_index', 'tin_masked'];
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb := to_jsonb(OLD);
  k text;
BEGIN
  IF OLD.anonymised_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (v_new - v_free - v_clearable) IS DISTINCT FROM (v_old - v_free - v_clearable) THEN
    RAISE EXCEPTION 'an anonymised record''s personal fields never change' USING ERRCODE = 'RA127';
  END IF;
  FOREACH k IN ARRAY v_clearable LOOP
    IF v_new ? k AND (v_new -> k) IS DISTINCT FROM (v_old -> k)
       AND NOT (jsonb_typeof(v_new -> k) = 'null' OR (k = 'id_status' AND v_new ->> k = 'none')) THEN
      RAISE EXCEPTION 'an anonymised record''s personal fields never change' USING ERRCODE = 'RA127';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
