-- M10 review (backend lead): VAT in the platform book, and a cancelled company's end of service.
-- Applied as rent_owner, after 0063.

-- 1. BE-2: VAT and levies payable (2210) in the platform book (decision 10), as the domain's chart
-- allows since 0057. The chart changes only by migration: its read-only trigger is lifted for this
-- one row and restored.
ALTER TABLE ledger_account DISABLE TRIGGER read_only;
UPDATE ledger_account SET books = ARRAY['owner', 'platform'] WHERE code = '2210';
ALTER TABLE ledger_account ENABLE TRIGGER read_only;
--> statement-breakpoint

-- 2. BE-4 (decision 12): after a cancellation, staff keep read-only access for the retention days,
-- then the company is archived (no sign-in, no company jobs; its data stays under retention). A
-- platform admin's reactivation makes it active again. Set only by the subscription engine, from
-- the platform company's context, in the company's own context so the change is in its chain.
CREATE FUNCTION app.set_subscriber_company_status(p_company_id uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_changed boolean;
BEGIN
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM app.platform_company_id() THEN
    RAISE EXCEPTION 'the subscription engine works from the platform company' USING ERRCODE = 'RA113';
  END IF;
  IF p_status NOT IN ('active', 'archived') THEN
    RAISE EXCEPTION 'a subscriber company is active or archived, not %', p_status USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  PERFORM set_config('app.actor_kind', 'system', true);
  UPDATE company SET status = p_status, updated_at = now()
  WHERE id = p_company_id AND kind IN ('landlord', 'agency') AND status IS DISTINCT FROM p_status;
  v_changed := FOUND;
  PERFORM set_config('app.company_id', v_company, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_changed;
END $$;

GRANT UPDATE (status) ON company TO rent_system;
ALTER FUNCTION app.set_subscriber_company_status(uuid, text) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.set_subscriber_company_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_subscriber_company_status(uuid, text) TO rent_app;
--> statement-breakpoint

-- 3. BE-5 (founder answer Q1): billing is turned on by a platform admin from a date. Global and
-- append-only; written only through the narrow function, read by anyone (the engine checks it).
SELECT app.make_append_only('billing_activation');
CREATE FUNCTION app.turn_on_billing(p_starts_on date, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid := uuidv7();
BEGIN
  PERFORM app.check_platform_writer();
  INSERT INTO billing_activation (id, starts_on, turned_on_by, note)
  VALUES (v_id, p_starts_on, app.current_person_id(), p_note);
  RETURN v_id;
END $$;
GRANT SELECT, INSERT ON billing_activation TO rent_system;
GRANT SELECT ON billing_activation TO rent_app;
ALTER FUNCTION app.turn_on_billing(date, text) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.turn_on_billing(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.turn_on_billing(date, text) TO rent_app;
--> statement-breakpoint

-- 4. BE-6 (founder answer Q2): credit notes on subscription invoices, in the platform company,
-- read by their subscriber, immutable but for the PDF.
SELECT app.enable_company_rls('subscription_credit_note');
SELECT app.enable_staff_only('subscription_credit_note');
CREATE POLICY subscriber_read ON subscription_credit_note FOR SELECT
  USING (subscriber_company_id = app.current_company_id());
CREATE TRIGGER frozen BEFORE UPDATE ON subscription_credit_note FOR EACH ROW EXECUTE FUNCTION app.freeze_except(
  'render_request_id!', 'document_id!', 'sha256!');
CREATE TRIGGER no_delete BEFORE DELETE ON subscription_credit_note FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER audit_row AFTER INSERT ON subscription_credit_note
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change('company_id');
GRANT SELECT, INSERT ON subscription_credit_note TO rent_app;
GRANT UPDATE (render_request_id, document_id, sha256) ON subscription_credit_note TO rent_app;
--> statement-breakpoint

-- 5. BE-12 and BE-16: an event in a subscriber's own audit chain, written by the subscription
-- engine inside its platform-company transaction (so it commits with the change, or not at all),
-- through the platform's system path, at most once per key (a retry writes nothing new).
CREATE FUNCTION app.append_subscriber_audit(p_company_id uuid, p_action text, p_record_type text,
  p_record_id text, p_data jsonb, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_done boolean := false;
BEGIN
  IF app.current_company_id() IS NULL OR app.current_company_id() IS DISTINCT FROM app.platform_company_id() THEN
    RAISE EXCEPTION 'the subscription engine works from the platform company' USING ERRCODE = 'RA113';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM company c WHERE c.id = p_company_id AND c.kind IN ('landlord', 'agency')) THEN
    RAISE EXCEPTION 'not a subscriber company' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NOT NULL AND EXISTS (SELECT 1 FROM audit_event e WHERE e.company_id = p_company_id
      AND e.action = p_action AND e.data ->> 'key' = p_key) THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.company_id', p_company_id::text, true);
  PERFORM set_config('app.actor_kind', 'system', true);
  PERFORM audit.append(p_company_id, p_action, p_record_type, p_record_id,
    coalesce(p_data, '{}'::jsonb) || CASE WHEN p_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('key', p_key) END);
  v_done := true;
  PERFORM set_config('app.company_id', v_company, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_done;
END $$;

GRANT SELECT ON audit_event TO rent_system;
ALTER FUNCTION app.append_subscriber_audit(uuid, text, text, text, jsonb, text) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.append_subscriber_audit(uuid, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.append_subscriber_audit(uuid, text, text, text, jsonb, text) TO rent_app;
GRANT USAGE ON SCHEMA audit TO rent_system;
GRANT EXECUTE ON FUNCTION audit.append(uuid, text, text, text, jsonb) TO rent_system;
