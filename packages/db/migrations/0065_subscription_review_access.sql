-- M10 review (access): the platform admin's onboarding never enters the customer's company.
-- Applied as rent_owner, after 0064.

-- 1. BE-16 and BE-20: a new company's first admin, added during onboarding from the platform
-- company's context by a platform admin, who never enters the customer's company (decision 13).
-- The membership and its audit events are written in the new company's own context as the
-- platform's system path, with the platform admin as the person, inside the onboarding's one
-- transaction. Only for a landlord or agency company that has no membership yet: the landlord
-- runs a landlord company, an agency's first person is its admin (AD-03).
CREATE FUNCTION app.onboard_first_admin(p_company_id uuid, p_person_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company text := coalesce(current_setting('app.company_id', true), '');
  v_kind text := coalesce(current_setting('app.actor_kind', true), '');
  v_company_kind text;
  v_role text;
  v_id uuid := uuidv7();
BEGIN
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
  INSERT INTO membership (id, company_id, person_id, role, invited_by)
  VALUES (v_id, p_company_id, p_person_id, v_role, app.current_person_id());
  PERFORM audit.append(p_company_id, 'membership.invited', 'membership', v_id::text,
    jsonb_build_object('role', v_role));
  PERFORM audit.append(p_company_id, 'company.onboarded', 'company', p_company_id::text,
    coalesce(p_data, '{}'::jsonb));
  PERFORM set_config('app.company_id', v_company, true);
  PERFORM set_config('app.actor_kind', v_kind, true);
  RETURN v_id;
END $$;
--> statement-breakpoint

GRANT SELECT ON person TO rent_system;
GRANT INSERT ON membership TO rent_system;
ALTER FUNCTION app.onboard_first_admin(uuid, uuid, jsonb) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.onboard_first_admin(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboard_first_admin(uuid, uuid, jsonb) TO rent_app;
--> statement-breakpoint

-- 2. BE-27 (decision 12): the companies, among a person's memberships, whose subscription has
-- ended (the latest subscription is cancelled), read at sign-in and on every request next to
-- app.company_access_for_person, so a read-only refusal there says the subscription has ended
-- rather than that it is past due. Only the person's own memberships; only company ids.
CREATE FUNCTION app.company_ended_for_person(p_person_id uuid)
RETURNS TABLE (company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.company_id FROM membership m
  WHERE m.person_id = p_person_id AND m.status IN ('invited', 'active')
    AND (SELECT s.status FROM subscription s WHERE s.subscriber_company_id = m.company_id
         ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'cancelled'
$$;
--> statement-breakpoint

GRANT SELECT ON subscription TO rent_system;
ALTER FUNCTION app.company_ended_for_person(uuid) OWNER TO rent_system;
REVOKE ALL ON FUNCTION app.company_ended_for_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.company_ended_for_person(uuid) TO rent_app;
--> statement-breakpoint

-- 3. BE-22 (decision 1): a subscriber reads its own subscription records and writes none. The
-- select-only policy keeps it from the platform company's rows, but the company policy alone would
-- let a subscriber's staff session write rows of its own into these tables (with its own company
-- id). Only the platform's paths write them: the engine and the console run as the system or a
-- platform admin (withPlatform), never as a company's staff, a tenant or a secure link.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscription', 'subscription_event', 'billing_snapshot', 'billing_snapshot_unit',
    'subscription_invoice', 'subscription_invoice_line', 'subscription_payment',
    'subscription_allocation', 'subscription_receipt', 'discount_code', 'discount_redemption',
    'subscription_credit_note'
  ] LOOP
    EXECUTE format('CREATE POLICY platform_writes_insert ON %I AS RESTRICTIVE FOR INSERT
      WITH CHECK (app.current_actor_kind() IN (''system'', ''platform_admin''))', t);
    EXECUTE format('CREATE POLICY platform_writes_update ON %I AS RESTRICTIVE FOR UPDATE
      USING (app.current_actor_kind() IN (''system'', ''platform_admin''))
      WITH CHECK (app.current_actor_kind() IN (''system'', ''platform_admin''))', t);
    EXECUTE format('CREATE POLICY platform_writes_delete ON %I AS RESTRICTIVE FOR DELETE
      USING (app.current_actor_kind() IN (''system'', ''platform_admin''))', t);
  END LOOP;
END $$;
