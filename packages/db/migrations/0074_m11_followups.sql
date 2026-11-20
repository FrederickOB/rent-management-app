-- M11 follow-ups: a first admin who already exists waits to accept (founder D2), rent tax an
-- owner still owed at the cut-over settled by a GRA payment (P25), and retention placeholders for
-- the record types that had no rule (CLAUDE.md section 7). Applied as rent_owner, after 0073.

-- 1. Founder D2: a new company's first admin, when the person already exists, is `invited` until
-- they accept from a password-and-TOTP session; a new person is active at once, as before. The
-- audit data stays {role} for an active admin.
DROP FUNCTION app.onboard_first_admin(uuid, uuid, jsonb);
CREATE FUNCTION app.onboard_first_admin(p_company_id uuid, p_person_id uuid, p_data jsonb, p_status text DEFAULT 'active')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_company text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_company_kind text;
  v_role text;
  v_id uuid := uuidv7();
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'invited') THEN
    RAISE EXCEPTION 'bad first-admin status' USING ERRCODE = '22023';
  END IF;
  IF NOT app.is_platform_admin() OR app.current_company_id() IS NULL
     OR app.current_company_id() IS DISTINCT FROM app.platform_company_id() THEN
    RAISE EXCEPTION 'companies are onboarded by platform admins, from the platform company' USING ERRCODE = 'RA113';
  END IF;
  SELECT c.kind INTO v_company_kind FROM company c WHERE c.id = p_company_id AND c.status = 'active';
  IF v_company_kind IS NULL OR v_company_kind NOT IN ('landlord', 'agency') THEN
    RAISE EXCEPTION 'not a subscriber company' USING ERRCODE = '22023';
  END IF;
  IF p_person_id IS NULL OR NOT EXISTS (SELECT 1 FROM person p WHERE p.id = p_person_id) THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM membership m WHERE m.company_id = p_company_id) THEN
    RAISE EXCEPTION 'the company has its first admin already' USING ERRCODE = 'RA114';
  END IF;
  v_role := CASE v_company_kind WHEN 'agency' THEN 'agency_admin' ELSE 'owner' END;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  PERFORM set_config('app.actor_kind', 'system', true);
  INSERT INTO membership (id, company_id, person_id, role, invited_by, status)
  VALUES (v_id, p_company_id, p_person_id, v_role, app.current_person_id(), p_status);
  PERFORM audit.append(p_company_id, 'membership.invited', 'membership', v_id::text,
    CASE WHEN p_status = 'invited' THEN jsonb_build_object('role', v_role, 'status', p_status)
         ELSE jsonb_build_object('role', v_role) END);
  PERFORM audit.append(p_company_id, 'company.onboarded', 'company', p_company_id::text,
    coalesce(p_data, '{}'::jsonb));
  PERFORM set_config('app.company_id', v_company, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_id;
END $$;
ALTER FUNCTION app.onboard_first_admin(uuid, uuid, jsonb, text) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.onboard_first_admin(uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboard_first_admin(uuid, uuid, jsonb, text) TO rent_app;
--> statement-breakpoint

-- 2. P25: a GRA payment settles an owner's opening rent tax item, as it does a receipt's.
CREATE OR REPLACE FUNCTION app.check_gra_payment_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind text;
  v_owed bigint;
BEGIN
  SELECT i.kind, i.tax_minor
      + coalesce((SELECT sum(c.tax_minor) FROM rent_tax_item c
                  WHERE c.company_id = i.company_id AND c.reverses_item_id = i.id), 0)
      - coalesce((SELECT sum(g.amount_minor) FROM gra_payment_item g
                  WHERE g.company_id = i.company_id AND g.item_id = i.id AND g.id <> NEW.id), 0)
    INTO v_kind, v_owed
  FROM rent_tax_item i WHERE i.company_id = NEW.company_id AND i.id = NEW.item_id;
  IF v_kind IS NULL OR NOT (v_kind IN ('receipt', 'carry_over', 'opening') OR (v_kind = 'withholding' AND EXISTS (
       SELECT 1 FROM rent_tax_item w JOIN withholding_write_off o ON o.company_id = w.company_id AND o.withholding_id = w.withholding_id
       WHERE w.company_id = NEW.company_id AND w.id = NEW.item_id))) OR NEW.amount_minor > v_owed THEN
    RAISE EXCEPTION 'a GRA payment settles rent tax item % only up to what it still owes', NEW.item_id
      USING ERRCODE = 'RA058';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- 3. Retention placeholders (CLAUDE.md section 7; OQ-14): the record types with no rule had none
-- to check. Null and unverified until counsel supplies them; new rows only.
INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', v.key, NULL, DATE '2000-01-01', 'Act 843 s.24; counsel must supply', 'unverified',
       'Effective-from date is a technical lower bound, not a legal commencement date. No value until counsel supplies one.',
       'migration:0074_m11_followups'
FROM (VALUES
  ('data_retention.other.artisans'),
  ('data_retention.other.owners'),
  ('data_retention.other.staff'),
  ('data_retention.other.consent_records'),
  ('data_retention.other.photos_and_recordings'),
  ('data_retention.other.audit_events'),
  ('data_retention.other.data_protection_requests')
) AS v(key)
WHERE NOT EXISTS (SELECT 1 FROM rule r WHERE r.country = 'GH' AND r.key = v.key);
